import type { CompanyConfig } from "../config/schema.ts";
import { ConflictError, ForbiddenError, NotFoundError, OpsdeskError, ToolDisabledError, ValidationError } from "../core/errors.ts";
import type { Json } from "../core/json.ts";
import type { ActionRecord } from "../core/types.ts";
import type { TenantTx } from "../store/types.ts";
import type { Toolset } from "../tools/registry.ts";
import type { Connectors } from "../connectors/types.ts";

export interface ActionRequest {
  tool: string;
  input: unknown;
  /** Who asked: a person, or a pipeline such as "system:email-intake". */
  actor: string;
  /** Same key, same action. Retries and duplicate webhooks never act twice. */
  idempotencyKey: string;
  reason?: string;
  /** Require a person even when the tool's policy is "auto" (e.g. low model confidence). */
  forceApproval?: boolean;
}

/**
 * Refusals are returned, not thrown, so the transaction still commits and the
 * refusal stays in the audit log. Callers turn `ok: false` into an error after
 * the transaction has finished.
 */
export type GatewayOutcome =
  | { ok: true; action: ActionRecord; created: boolean }
  | { ok: false; error: OpsdeskError };

export function unwrap(outcome: GatewayOutcome): { action: ActionRecord; created: boolean } {
  if (!outcome.ok) throw outcome.error;
  return outcome;
}

export interface GatewayScope {
  tx: TenantTx;
  config: CompanyConfig;
  toolset: Toolset;
  /** The company's external systems. Only tools, run by the gateway, use them. */
  connectors?: Connectors;
}

/**
 * The only path from intent to effect. Models, pipelines and people all call
 * `request`; the gateway checks the tool is enabled, validates the input,
 * applies the approval policy, de-duplicates, and writes the audit trail.
 */
export class ActionGateway {
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async request(scope: GatewayScope, req: ActionRequest): Promise<GatewayOutcome> {
    const { tx, config, toolset } = scope;

    if (!toolset.has(req.tool)) {
      await tx.appendAudit({
        actor: req.actor,
        type: "action.refused",
        subject: req.tool,
        data: { reason: "tool_disabled", idempotency_key: req.idempotencyKey },
      });
      return { ok: false, error: new ToolDisabledError(req.tool) };
    }
    const { tool, settings, approval } = toolset.get(req.tool);

    if (tool.effect === "write" && approval === "never") {
      await tx.appendAudit({
        actor: req.actor,
        type: "action.refused",
        subject: req.tool,
        data: { reason: "policy_never", idempotency_key: req.idempotencyKey },
      });
      return { ok: false, error: new ForbiddenError(`Tool "${req.tool}" is set to never run for this company`) };
    }

    const existing = await tx.getActionByKey(req.idempotencyKey);
    if (existing) {
      await tx.appendAudit({ actor: req.actor, type: "action.deduplicated", subject: existing.id, data: { tool: req.tool } });
      return { ok: true, action: existing, created: false };
    }

    const parsed = tool.inputSchema.safeParse(req.input);
    if (!parsed.success) {
      await tx.appendAudit({
        actor: req.actor,
        type: "action.refused",
        subject: req.tool,
        data: { reason: "invalid_input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      });
      return { ok: false, error: new ValidationError(`Invalid input for ${req.tool}`, parsed.error.issues) };
    }
    const input = parsed.data as Json;
    const now = this.clock();

    let preview: Json | null = null;
    if (tool.preview) {
      try {
        preview = tool.preview({ tenantId: tx.tenantId, config, settings, now }, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await tx.appendAudit({ actor: req.actor, type: "action.refused", subject: req.tool, data: { reason: "preview_failed", message } });
        return {
          ok: false,
          error: error instanceof OpsdeskError ? error : new ValidationError(`Could not prepare ${req.tool}: ${message}`),
        };
      }
    }

    const needsApproval = tool.effect === "write" && (approval === "required" || req.forceApproval === true);
    const { record, created } = await tx.insertAction({
      tool: req.tool,
      input,
      preview,
      status: "pending_approval",
      idempotencyKey: req.idempotencyKey,
      reason: req.reason ?? null,
      requestedBy: req.actor,
    });
    if (!created) return { ok: true, action: record, created: false };

    await tx.appendAudit({
      actor: req.actor,
      type: "action.proposed",
      subject: record.id,
      data: { tool: req.tool, input, preview, needs_approval: needsApproval, reason: req.reason ?? null },
    });

    if (!needsApproval) {
      return { ok: true, action: await this.run(scope, record, "policy:auto"), created: true };
    }
    return { ok: true, action: record, created: true };
  }

  async approve(scope: GatewayScope, actionId: string, approver: string, note?: string): Promise<GatewayOutcome> {
    const action = await this.pending(scope.tx, actionId);
    if (approver === action.requestedBy) {
      await scope.tx.appendAudit({ actor: approver, type: "action.refused", subject: action.id, data: { reason: "self_approval" } });
      return { ok: false, error: new ForbiddenError("The requester of an action cannot approve it") };
    }
    if (!scope.toolset.has(action.tool) || scope.toolset.get(action.tool).approval === "never") {
      // Switched off, or set to never, after it was proposed: refuse rather than act on stale permission.
      await scope.tx.appendAudit({ actor: approver, type: "action.refused", subject: action.id, data: { reason: "tool_disabled" } });
      return { ok: false, error: new ToolDisabledError(action.tool) };
    }
    const now = this.clock().toISOString();
    const approved = await scope.tx.updateAction(action.id, { decidedBy: approver, decidedAt: now, decisionNote: note ?? null });
    await scope.tx.appendAudit({ actor: approver, type: "action.approved", subject: action.id, data: { tool: action.tool, note: note ?? null } });
    return { ok: true, action: await this.run(scope, approved, approver), created: false };
  }

  async reject(scope: GatewayScope, actionId: string, approver: string, note: string): Promise<ActionRecord> {
    const action = await this.pending(scope.tx, actionId);
    const rejected = await scope.tx.updateAction(action.id, {
      status: "rejected",
      decidedBy: approver,
      decidedAt: this.clock().toISOString(),
      decisionNote: note,
    });
    await scope.tx.appendAudit({ actor: approver, type: "action.rejected", subject: action.id, data: { tool: action.tool, note } });
    return rejected;
  }

  private async pending(tx: TenantTx, actionId: string): Promise<ActionRecord> {
    const action = await tx.getAction(actionId);
    if (!action) throw new NotFoundError("Action");
    if (action.status !== "pending_approval") {
      throw new ConflictError("action_not_pending", `Action is ${action.status}, not pending approval`);
    }
    return action;
  }

  private async run(scope: GatewayScope, action: ActionRecord, actor: string): Promise<ActionRecord> {
    const { tx, config, toolset } = scope;
    const { tool, settings } = toolset.get(action.tool);
    const input = tool.inputSchema.parse(action.input);
    try {
      const result = await tx.attempt(() =>
        tool.execute({ tenantId: tx.tenantId, config, settings, tx, now: this.clock(), actor, connectors: scope.connectors ?? {} }, input),
      );
      const done = await tx.updateAction(action.id, { status: "executed", result });
      await tx.appendAudit({ actor, type: "action.executed", subject: action.id, data: { tool: action.tool, result } });
      return done;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await tx.updateAction(action.id, { status: "failed", error: message });
      await tx.appendAudit({ actor, type: "action.failed", subject: action.id, data: { tool: action.tool, error: message } });
      return failed;
    }
  }
}
