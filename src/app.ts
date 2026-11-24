import express, { type Express } from "express";
import type { ApiKeys } from "./http/auth.ts";
import { createOpsdeskRouter } from "./http/router.ts";
import type { Runtime } from "./runtime.ts";

export function createApp(rt: Runtime, keys: ApiKeys): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, store: rt.store.kind, extractor: rt.extractor.name });
  });
  app.use(createOpsdeskRouter(rt, keys));
  return app;
}

export { createOpsdeskRouter } from "./http/router.ts";
export { ApiKeys } from "./http/auth.ts";
export { createRuntime } from "./runtime.ts";
export { MemoryStore } from "./store/memory.ts";
export { PostgresStore } from "./store/postgres.ts";
