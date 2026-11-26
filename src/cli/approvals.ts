import { can } from "../auth/principal.ts";
import { NotFoundError, ForbiddenError } from "../core/errors.ts";
import type { ActionRecord } from "../core/types.ts";
import { actionFingerprint, expiresAt } from "../gateway/gateway.ts";
import { scopeFor, type Runtime } from "../runtime.ts";

/**
 * Approvals from the server's command line, for people whose app cannot show
 * an approval prompt. The approver is named with --as and must be an active
 * approver or owner of that company; the audit log records them and "cli".
 */

export async function pendingApprovals(rt: Runtime, tenantId: string) {
  return rt.store.withTenant(tenantId, async (tx) => {
    const scope = await scopeFor(rt, tx);
    return (await tx.listActions({ status: "pending_approval" })).map((a) => ({
      id: a.id,
      tool: a.tool,
      requested_by: a.requestedBy,
      requested_at: a.requestedAt,
      expires_at: expiresAt(a, scope.config).toISOString(),
      reason: a.reason,
      fingerprint: actionFingerprint(a),
    }));
  });
}

/** Checks the named person may approve for this company, and returns the action as it stands now. */
export async function prepareDecision(rt: Runtime, tenantId: string, actionId: string, asEmail: string) {
  return rt.store.withTenant(tenantId, async (tx) => {
    const person = (await tx.listStaff()).find((p) => p.email === asEmail.toLowerCase() && p.revokedAt === null);
    if (!person) throw new ForbiddenError(`${asEmail} is not an active person at ${tenantId}`);
    if (!can(person.role, "approve")) throw new ForbiddenError(`${asEmail} is a ${person.role}; only approvers and owners can decide`);
    const action = await tx.getAction(actionId);
    if (!action) throw new NotFoundError(`Action ${actionId}`);
    return { action, fingerprint: actionFingerprint(action), approver: person.email };
  });
}

/** Human-readable summary of exactly what will run, for the confirmation step. */
export function describeForApproval(action: ActionRecord, fingerprint: string): string {
  return [
    `Action:       ${action.tool} (${action.status})`,
    `Requested by: ${action.requestedBy} at ${action.requestedAt}`,
    action.reason ? `Reason:       ${action.reason}` : null,
    `Fingerprint:  ${fingerprint}`,
    "",
    "What will run:",
    JSON.stringify(action.preview ?? action.input, null, 2),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Approves exactly the action that was shown (the fingerprint must still match). */
export async function approveFromCli(rt: Runtime, tenantId: string, actionId: string, approver: string, fingerprint: string, note?: string) {
  return rt.store.withTenant(tenantId, async (tx) =>
    rt.gateway.approve(await scopeFor(rt, tx), actionId, approver, note, { fingerprint, via: "cli" }),
  );
}

export async function rejectFromCli(rt: Runtime, tenantId: string, actionId: string, approver: string, note: string) {
  return rt.store.withTenant(tenantId, async (tx) => rt.gateway.reject(await scopeFor(rt, tx), actionId, approver, note));
}
