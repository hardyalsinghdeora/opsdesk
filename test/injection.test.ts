import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { FakeMailbox } from "../src/connectors/fakes.ts";
import { handleInboundEmail } from "../src/pipelines/email-intake.ts";
import { injectionSignals } from "../src/pipelines/injection.ts";
import type { Runtime } from "../src/runtime.ts";
import { fixture, runtimeWith, storeFactories } from "./helpers.ts";

describe("spotting text aimed at the AI", () => {
  it("flags instructions addressed to an assistant", () => {
    const text = fixture("gulfcool-injection").text;
    assert.deepEqual(injectionSignals(text).sort(), ["addressed_to_ai", "override", "role_claim", "skip_approval"]);
  });

  it("does not flag ordinary customer wording", () => {
    for (const text of [
      "Please ignore my previous email, the address was wrong.",
      "You are now on our supplier list.",
      "We don't need approval from the landlord for this work.",
      fixture("gulfcool-quote").text,
      fixture("northwind-quote").text,
    ]) {
      assert.deepEqual(injectionSignals(text), [], text);
    }
  });
});

for (const factory of storeFactories()) {
  describe(`an email that tries to steer the AI (${factory.name})`, () => {
    let rt: Runtime;
    beforeEach(async () => {
      rt = await runtimeWith(await factory.make());
    });

    it("causes no automatic action, sends nothing, and is parked with the reason", async () => {
      const result = await handleInboundEmail(rt, "gulfcool", fixture("gulfcool-injection"));
      assert.equal(result.status, "needs_review");
      for (const action of result.actions) {
        assert.equal(action.status, "pending_approval", `${action.tool} waits for a person`);
        assert.match(action.reason ?? "", /instructions aimed at the AI/);
      }
      const everything = JSON.stringify(await rt.store.withTenant("gulfcool", (tx) => tx.listActions()));
      assert.doesNotMatch(everything, /payments@billing-update\.example/, "the address in the email is never a target");
      assert.equal((rt.connectors.get("gulfcool")!.mailbox as FakeMailbox).sent.length, 0);
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listQuotes())).length, 0);
      const audit = await rt.store.withTenant("gulfcool", (tx) => tx.listAudit());
      assert.ok(audit.some((e) => e.type === "email.suspicious"));
    });
  });
}
