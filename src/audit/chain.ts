import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../core/json.ts";
import type { AuditDraft, AuditEntry } from "../core/types.ts";

export const GENESIS_HASH = "0".repeat(64);

function hashOf(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        tenantId: entry.tenantId,
        seq: entry.seq,
        id: entry.id,
        at: entry.at,
        actor: entry.actor,
        type: entry.type,
        subject: entry.subject,
        data: entry.data,
        prevHash: entry.prevHash,
      }),
    )
    .digest("hex");
}

/** Build the next entry of a tenant's chain. Shared by every store. */
export function sealAuditEntry(
  tenantId: string,
  previous: AuditEntry | null,
  draft: AuditDraft,
  now: Date = new Date(),
): AuditEntry {
  const unsealed = {
    tenantId,
    seq: (previous?.seq ?? 0) + 1,
    id: randomUUID(),
    at: now.toISOString(),
    actor: draft.actor,
    type: draft.type,
    subject: draft.subject,
    data: draft.data,
    prevHash: previous?.hash ?? GENESIS_HASH,
  };
  return { ...unsealed, hash: hashOf(unsealed) };
}

export type ChainCheck = { ok: true; entries: number } | { ok: false; entries: number; brokenAtSeq: number; reason: string };

/** Recompute every hash. Any edit, deletion or reordering breaks the chain. */
export function verifyAuditChain(entries: AuditEntry[]): ChainCheck {
  let prev: AuditEntry | null = null;
  for (const entry of entries) {
    const expectedSeq = (prev?.seq ?? 0) + 1;
    if (entry.seq !== expectedSeq) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: `expected seq ${expectedSeq}` };
    }
    if (entry.prevHash !== (prev?.hash ?? GENESIS_HASH)) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: "prevHash does not match" };
    }
    const { hash, ...rest } = entry;
    if (hashOf(rest) !== hash) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: "content does not match hash" };
    }
    prev = entry;
  }
  return { ok: true, entries: entries.length };
}
