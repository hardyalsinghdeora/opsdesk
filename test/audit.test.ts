import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sealAuditEntry, verifyAuditChain } from "../src/audit/chain.ts";
import type { AuditEntry } from "../src/core/types.ts";

function chain(n: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(sealAuditEntry("t1", out.at(-1) ?? null, { actor: "a", type: "x", subject: null, data: { i } }));
  }
  return out;
}

describe("audit hash chain", () => {
  it("verifies an untouched chain", () => {
    assert.deepEqual(verifyAuditChain(chain(5)), { ok: true, entries: 5 });
  });

  it("detects an edited entry", () => {
    const entries = chain(5);
    (entries[2]!.data as any).i = 99;
    const check = verifyAuditChain(entries);
    assert.equal(check.ok, false);
    assert.equal(!check.ok && check.brokenAtSeq, 3);
  });

  it("detects a deleted entry", () => {
    const entries = chain(5);
    entries.splice(1, 1);
    assert.equal(verifyAuditChain(entries).ok, false);
  });

  it("detects an entry rewritten with a fresh hash, because the next link breaks", () => {
    const entries = chain(4);
    const forged = sealAuditEntry("t1", entries[0]!, { actor: "intruder", type: "x", subject: null, data: {} });
    entries[1] = { ...forged, seq: 2 };
    const check = verifyAuditChain(entries);
    assert.equal(check.ok, false);
  });
});
