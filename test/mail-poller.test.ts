import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { FakeMailbox } from "../src/connectors/fakes.ts";
import type { Runtime } from "../src/runtime.ts";
import { CURSOR_KEY, pollMailbox } from "../src/worker/mail-poller.ts";
import { fixture, runtimeWith, storeFactories } from "./helpers.ts";

for (const factory of storeFactories()) {
  describe(`mailbox poller (${factory.name})`, () => {
    let rt: Runtime;
    let mailbox: FakeMailbox;
    beforeEach(async () => {
      rt = await runtimeWith(await factory.make());
      mailbox = rt.connectors.get("gulfcool")!.mailbox as FakeMailbox;
    });
    const cursor = () => rt.store.withTenant("gulfcool", (tx) => tx.getSyncState(CURSOR_KEY));
    const inbound = () => rt.store.withTenant("gulfcool", (tx) => tx.listInbound());

    it("reads new mail oldest first, runs intake, and saves where it got to", async () => {
      mailbox.deliver({ ...fixture("gulfcool-quote"), receivedAt: "2026-11-25T09:00:00.000Z" });
      mailbox.deliver({ ...fixture("gulfcool-newsletter"), receivedAt: "2026-11-25T08:00:00.000Z" });
      const result = await pollMailbox(rt, "gulfcool");
      assert.deepEqual([result.fetched, result.handled, result.stoppedAt], [2, 2, null]);
      assert.deepEqual((await inbound()).map((m) => m.status).sort(), ["ignored", "processed"]);
      assert.equal(await cursor(), "2026-11-25T09:00:00.000Z");
    });

    it("picks up only what arrived since, and never acts twice on the same message", async () => {
      mailbox.deliver({ ...fixture("gulfcool-quote"), receivedAt: "2026-11-25T09:00:00.000Z" });
      await pollMailbox(rt, "gulfcool");
      assert.equal((await pollMailbox(rt, "gulfcool")).fetched, 0);
      // The same message seen again later (a provider re-delivery): intake drops it by Message-ID.
      mailbox.deliver({ ...fixture("gulfcool-quote"), receivedAt: "2026-11-25T10:00:00.000Z" });
      await pollMailbox(rt, "gulfcool");
      assert.equal((await rt.store.withTenant("gulfcool", (tx) => tx.listLeads())).length, 1);
    });

    it("stops without moving its position when intake refuses, so the mail is retried later", async () => {
      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({ channels: { email: { enabled: false } } }));
      mailbox.deliver({ ...fixture("gulfcool-quote"), receivedAt: "2026-11-25T09:00:00.000Z" });
      const result = await pollMailbox(rt, "gulfcool");
      assert.equal(result.handled, 0);
      assert.match(result.stoppedAt?.reason ?? "", /channel_disabled/);
      assert.equal(await cursor(), null);

      await rt.store.withTenant("gulfcool", (tx) => tx.setOverrides({}));
      assert.equal((await pollMailbox(rt, "gulfcool")).handled, 1);
    });
  });
}
