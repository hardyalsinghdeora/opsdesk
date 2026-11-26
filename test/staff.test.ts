import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { bearerToken, can, hashToken, newToken } from "../src/auth/principal.ts";
import type { Runtime } from "../src/runtime.ts";
import { runtimeWith, storeFactories } from "./helpers.ts";

describe("roles", () => {
  it("grants each role only what it needs", () => {
    assert.equal(can("viewer", "request"), false);
    assert.equal(can("staff", "request"), true);
    assert.equal(can("staff", "approve"), false);
    assert.equal(can("approver", "approve"), true);
    assert.equal(can("approver", "admin"), false);
    assert.equal(can("owner", "admin"), true);
  });

  it("only accepts opsdesk tokens from a Bearer header", () => {
    const token = newToken();
    assert.equal(bearerToken(`Bearer ${token}`), token);
    assert.equal(bearerToken(token), null);
    assert.equal(bearerToken("Bearer some-other-token"), null);
    assert.equal(bearerToken(undefined), null);
  });
});

for (const factory of storeFactories()) {
  describe(`people and tokens (${factory.name})`, () => {
    let rt: Runtime;
    const token = newToken();

    before(async () => {
      rt = await runtimeWith(await factory.make());
      await rt.store.withTenant("gulfcool", (tx) =>
        tx.insertStaff({ email: "Maya@GulfCool.example", name: "Maya", role: "approver", tokenHash: hashToken(token) }),
      );
    });

    it("resolves a token to its person, company and role", async () => {
      const who = await rt.store.resolveToken(hashToken(token));
      assert.equal(who?.tenantId, "gulfcool");
      assert.equal(who?.actor, "maya@gulfcool.example");
      assert.equal(who?.role, "approver");
    });

    it("never returns the token or its hash when listing people", async () => {
      const people = await rt.store.withTenant("gulfcool", (tx) => tx.listStaff());
      assert.equal(people.length, 1);
      assert.ok(!("tokenHash" in people[0]!));
      assert.ok(!JSON.stringify(people).includes(hashToken(token)));
    });

    it("refuses a second active account with the same email", async () => {
      await assert.rejects(
        rt.store.withTenant("gulfcool", (tx) =>
          tx.insertStaff({ email: "maya@gulfcool.example", name: "Maya 2", role: "owner", tokenHash: hashToken(newToken()) }),
        ),
        /already has access/,
      );
    });

    it("keeps each company's people to itself", async () => {
      const others = await rt.store.withTenant("northwind", (tx) => tx.listStaff());
      assert.equal(others.length, 0);
      assert.equal(await rt.store.withTenant("northwind", (tx) => tx.revokeStaff("maya@gulfcool.example")), false);
    });

    it("rejects unknown tokens", async () => {
      assert.equal(await rt.store.resolveToken(hashToken(newToken())), null);
    });

    it("stops a removed person's token at once, and lets them be added back with a new one", async () => {
      assert.equal(await rt.store.withTenant("gulfcool", (tx) => tx.revokeStaff("maya@gulfcool.example")), true);
      assert.equal(await rt.store.resolveToken(hashToken(token)), null);
      const fresh = newToken();
      await rt.store.withTenant("gulfcool", (tx) =>
        tx.insertStaff({ email: "maya@gulfcool.example", name: "Maya", role: "staff", tokenHash: hashToken(fresh) }),
      );
      assert.equal((await rt.store.resolveToken(hashToken(fresh)))?.role, "staff");
    });
  });
}
