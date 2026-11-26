import { ConflictError, type OpsdeskError } from "../core/errors.ts";
import type { Json } from "../core/json.ts";
import type { ActionRecord, InboundEmailInput, InboundStatus } from "../core/types.ts";
import type { GatewayOutcome } from "../gateway/gateway.ts";
import { buildExtractionRequest, ExtractionError, type Extraction, type ExtractionRequest } from "../llm/extraction.ts";
import { scopeFor, type Runtime } from "../runtime.ts";
import type { ResolvedWorkflow } from "../workflows/workflows.ts";

export const INTAKE_ACTOR = "system:email-intake";

export interface IntakeResult {
  inboundId: string;
  status: InboundStatus | "duplicate";
  extraction: Extraction | null;
  /** The workflow the email was routed to, or null if none matched. */
  workflow: string | null;
  actions: ActionRecord[];
  refusals: { tool: string; code: string; message: string }[];
}

/** One idempotency key per email and tool, so a re-delivered email never acts twice. */
const stepKey = (messageId: string, tool: string) =>
  tool === "crm.create_lead" ? `email:${messageId}:lead` : tool === "quote.issue" ? `email:${messageId}:quote` : `email:${messageId}:${tool}`;

function senderAddress(from: string): string | null {
  return /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(from)?.[0] ?? null;
}

/** The first active email workflow, by priority, whose intent matches (or that takes any intent). */
export function routeEmail(workflows: ResolvedWorkflow[], intent: string | null): ResolvedWorkflow | null {
  return (
    workflows.find(
      (wf) => wf.active && wf.trigger.channel === "email" && (wf.trigger.intent === undefined || wf.trigger.intent === intent),
    ) ?? null
  );
}

type StepInput = { input: Json; note?: string } | { skip: string };

/**
 * Turns the extraction into one tool's input. Plain code, no model: the model
 * only labelled the email. A tool with no builder here cannot run from email.
 */
function buildStepInput(tool: string, ex: Extraction, email: InboundEmailInput, contactEmail: string | null): StepInput {
  if (tool === "crm.create_lead") {
    return {
      input: {
        contact: { ...ex.contact, email: contactEmail },
        summary: ex.summary || email.subject,
        urgency: ex.urgency,
        custom_fields: ex.custom_fields,
        source: "email",
        source_ref: email.messageId,
      },
    };
  }
  if (tool === "quote.issue") {
    if (!ex.wants_quote) return { skip: "the sender did not ask for a price" };
    const mapped = ex.items.filter((i) => i.service_code !== null);
    const unmapped = ex.items.filter((i) => i.service_code === null);
    if (mapped.length === 0) return { skip: "quote requested but nothing matched the catalogue" };
    return {
      input: {
        customer: { name: ex.contact.name, email: contactEmail },
        items: mapped.map((i) => ({ code: i.service_code!, quantity: i.quantity, note: i.description })),
        source_ref: email.messageId,
      },
      note: unmapped.length > 0 ? `not priced: ${unmapped.map((i) => i.description).join(", ")}` : undefined,
    };
  }
  return { skip: `"${tool}" cannot run from an email yet` };
}

/**
 * Inbound email -> extraction -> the company's workflow -> proposed actions.
 *
 * Three steps, so no database transaction is held open during the model call:
 *   1. record the email (idempotent on Message-ID) and build the request
 *   2. call the model, outside any transaction
 *   3. route to a workflow and run its steps through the gateway, which
 *      decides what runs now, what waits for a person and what is refused
 */
export async function handleInboundEmail(rt: Runtime, tenantId: string, email: InboundEmailInput): Promise<IntakeResult> {
  const receivedAt = email.receivedAt ?? rt.clock().toISOString();

  type Step1 =
    | { kind: "channel_disabled" }
    | { kind: "duplicate"; result: IntakeResult }
    | { kind: "new"; inboundId: string; request: ExtractionRequest };

  const step1 = await rt.store.withTenant<Step1>(tenantId, async (tx) => {
    const { config, toolset } = await scopeFor(rt, tx);
    if (!config.channels.email.enabled) {
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.refused", subject: email.messageId, data: { reason: "channel_disabled" } });
      return { kind: "channel_disabled" };
    }
    const { record, created } = await tx.recordInbound({ ...email, receivedAt });
    if (!created) {
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.duplicate", subject: record.id, data: { message_id: email.messageId } });
      const prefix = `email:${email.messageId}:`;
      const actions = (await tx.listActions()).filter((a) => a.idempotencyKey.startsWith(prefix));
      return {
        kind: "duplicate",
        result: { inboundId: record.id, status: "duplicate", extraction: null, workflow: null, actions, refusals: [] },
      };
    }
    await tx.appendAudit({
      actor: INTAKE_ACTOR,
      type: "email.received",
      subject: record.id,
      data: { message_id: email.messageId, from: email.from, subject: email.subject },
    });
    return { kind: "new", inboundId: record.id, request: buildExtractionRequest(config, toolset, email) };
  });

  if (step1.kind === "channel_disabled") throw new ConflictError("channel_disabled", "Email intake is not enabled for this company");
  if (step1.kind === "duplicate") return step1.result;
  const { inboundId, request } = step1;

  let extracted;
  try {
    extracted = await rt.extractor.extract(request);
  } catch (error) {
    const kind = error instanceof ExtractionError ? error.kind : "api_error";
    const message = error instanceof Error ? error.message : String(error);
    await rt.store.withTenant(tenantId, async (tx) => {
      await tx.updateInbound(inboundId, { status: "needs_review", error: `${kind}: ${message}` });
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.extraction_failed", subject: inboundId, data: { kind, message, extractor: rt.extractor.name } });
    });
    return { inboundId, status: "needs_review", extraction: null, workflow: null, actions: [], refusals: [] };
  }

  const ex = extracted.extraction;
  return rt.store.withTenant(tenantId, async (tx) => {
    const scope = await scopeFor(rt, tx);
    const { config } = scope;
    await tx.appendAudit({
      actor: INTAKE_ACTOR,
      type: "email.extracted",
      subject: inboundId,
      data: { extractor: rt.extractor.name, model: extracted.model, confidence: ex.confidence, intent: ex.intent, usage: (extracted.usage ?? null) as Json },
    });

    if (!ex.is_business_inquiry) {
      await tx.updateInbound(inboundId, { status: "ignored", extraction: ex as unknown as Json });
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.ignored", subject: inboundId, data: { summary: ex.summary } });
      return { inboundId, status: "ignored", extraction: ex, workflow: null, actions: [], refusals: [] };
    }

    // Workflows were checked when this transaction began, so a switch flipped
    // since the model call is respected here.
    const workflow = routeEmail(scope.workflows, ex.intent);
    if (!workflow) {
      await tx.updateInbound(inboundId, { status: "needs_review", extraction: ex as unknown as Json, error: "no active workflow matches this email" });
      await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.unrouted", subject: inboundId, data: { intent: ex.intent } });
      return { inboundId, status: "needs_review", extraction: ex, workflow: null, actions: [], refusals: [] };
    }
    await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.routed", subject: inboundId, data: { workflow: workflow.id, intent: ex.intent } });

    const min = config.channels.email.min_confidence;
    const lowConfidence = ex.confidence < min;
    const actions: ActionRecord[] = [];
    const refusals: IntakeResult["refusals"] = [];
    const collect = (tool: string, outcome: GatewayOutcome) => {
      if (outcome.ok) actions.push(outcome.action);
      else refusals.push({ tool, code: (outcome.error as OpsdeskError).code, message: outcome.error.message });
    };
    const notes: string[] = [];
    if (lowConfidence) notes.push(`model confidence ${ex.confidence.toFixed(2)} is below ${min}`);
    const contactEmail = ex.contact.email ?? senderAddress(email.from);

    for (const step of workflow.steps) {
      if (step.approval === "never") {
        notes.push(`${step.tool} is set to never in workflow ${workflow.id}`);
        continue;
      }
      const built = buildStepInput(step.tool, ex, email, contactEmail);
      if ("skip" in built) {
        await tx.appendAudit({ actor: INTAKE_ACTOR, type: "email.step_skipped", subject: inboundId, data: { workflow: workflow.id, tool: step.tool, reason: built.skip } });
        // A quote the sender never asked for is not a problem; anything else is.
        if (!(step.tool === "quote.issue" && built.skip === "the sender did not ask for a price")) notes.push(built.skip);
        continue;
      }
      const stepNotes = [...notes, ...(built.note ? [built.note] : [])];
      collect(
        step.tool,
        await rt.gateway.request(scope, {
          tool: step.tool,
          actor: INTAKE_ACTOR,
          idempotencyKey: stepKey(email.messageId, step.tool),
          // The workflow can make a step stricter; low confidence makes everything wait for a person.
          forceApproval: lowConfidence || step.approval === "required" || built.note !== undefined,
          reason: [`workflow ${workflow.id}`, ...stepNotes].join("; "),
          input: built.input,
        }),
      );
    }

    const status: InboundStatus = lowConfidence || refusals.length > 0 || notes.length > 0 ? "needs_review" : "processed";
    await tx.updateInbound(inboundId, { status, extraction: ex as unknown as Json });
    return { inboundId, status, extraction: ex, workflow: workflow.id, actions, refusals };
  });
}
