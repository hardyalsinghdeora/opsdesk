import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { verifyAuditChain } from "../audit/chain.ts";
import { parseOverrides, resolveCompanyConfig } from "../config/loader.ts";
import { ConfigError, NotFoundError, OpsdeskError, ValidationError } from "../core/errors.ts";
import type { Json } from "../core/json.ts";
import { unwrap } from "../gateway/gateway.ts";
import { handleInboundEmail } from "../pipelines/email-intake.ts";
import { scopeFor, type Runtime } from "../runtime.ts";
import { authenticate, requireRole, type ApiKeys, type Principal } from "./auth.ts";

const InboundEmailBody = z
  .object({
    messageId: z.string().min(1).max(500),
    from: z.string().min(3).max(500),
    to: z.string().min(3).max(500),
    subject: z.string().max(1000).default(""),
    text: z.string().max(100_000),
    receivedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const DecisionBody = z.object({ note: z.string().max(2000).optional() }).strict();
const RejectBody = z.object({ note: z.string().min(1).max(2000) }).strict();
const StatusQuery = z.enum(["pending_approval", "executed", "rejected", "failed"]).optional();

function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new ValidationError("Invalid request body", parsed.error.issues);
  return parsed.data;
}

const principalOf = (res: Response) => res.locals.principal as Principal;
const tenantOf = (req: Request) => String(req.params.tenant);

/**
 * All opsdesk routes as one Express router, so a client can mount it inside
 * their own app (`app.use("/ops", createOpsdeskRouter(rt, keys))`) or run it
 * standalone via createApp.
 */
export function createOpsdeskRouter(rt: Runtime, keys: ApiKeys): Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  const t = express.Router({ mergeParams: true });
  router.use("/t/:tenant", authenticate(keys), t);

  t.post("/inbound/email", requireRole("ingest", "admin"), async (req, res) => {
    const result = await handleInboundEmail(rt, tenantOf(req), body(InboundEmailBody, req.body));
    res.status(result.status === "duplicate" ? 200 : 201).json(result);
  });

  t.get("/tools", requireRole("operator", "admin"), async (req, res) => {
    const out = await rt.store.withTenant(tenantOf(req), async (tx) => {
      const { config, toolset } = await scopeFor(rt, tx);
      return { company: config.name, tools: toolset.describe(), known: rt.registry.known() };
    });
    res.json(out);
  });

  t.get("/actions", requireRole("operator", "admin"), async (req, res) => {
    const status = StatusQuery.parse(req.query.status);
    res.json(await rt.store.withTenant(tenantOf(req), (tx) => tx.listActions({ status })));
  });

  t.get("/actions/:id", requireRole("operator", "admin"), async (req, res) => {
    const action = await rt.store.withTenant(tenantOf(req), (tx) => tx.getAction(String(req.params.id)));
    if (!action) throw new NotFoundError("Action");
    res.json(action);
  });

  t.post("/actions/:id/approve", requireRole("operator", "admin"), async (req, res) => {
    const { note } = body(DecisionBody, req.body);
    const outcome = await rt.store.withTenant(tenantOf(req), async (tx) =>
      rt.gateway.approve(await scopeFor(rt, tx), String(req.params.id), principalOf(res).actor, note),
    );
    res.json(unwrap(outcome).action);
  });

  t.post("/actions/:id/reject", requireRole("operator", "admin"), async (req, res) => {
    const { note } = body(RejectBody, req.body);
    const action = await rt.store.withTenant(tenantOf(req), async (tx) =>
      rt.gateway.reject(await scopeFor(rt, tx), String(req.params.id), principalOf(res).actor, note),
    );
    res.json(action);
  });

  t.get("/leads", requireRole("operator", "admin"), async (req, res) => {
    res.json(await rt.store.withTenant(tenantOf(req), (tx) => tx.listLeads()));
  });

  t.get("/quotes", requireRole("operator", "admin"), async (req, res) => {
    res.json(await rt.store.withTenant(tenantOf(req), (tx) => tx.listQuotes()));
  });

  t.get("/audit", requireRole("operator", "admin"), async (req, res) => {
    res.json(await rt.store.withTenant(tenantOf(req), (tx) => tx.listAudit()));
  });

  t.get("/audit/verify", requireRole("operator", "admin"), async (req, res) => {
    res.json(verifyAuditChain(await rt.store.withTenant(tenantOf(req), (tx) => tx.listAudit())));
  });

  t.get("/settings", requireRole("admin"), async (req, res) => {
    res.json(await rt.store.withTenant(tenantOf(req), (tx) => tx.getOverrides()));
  });

  /** Replace the runtime overrides. Rejected unless the merged config is valid. */
  t.put("/settings", requireRole("admin"), async (req, res) => {
    const overrides = parseOverrides(req.body);
    const tenantId = tenantOf(req);
    const resolved = await rt.store.withTenant(tenantId, async (tx) => {
      let toolset;
      try {
        toolset = rt.registry.forCompany(resolveCompanyConfig(rt.source, tenantId, overrides));
      } catch (error) {
        // A bad override is the caller's mistake, not a server fault.
        if (error instanceof ConfigError) throw new ValidationError(error.message, error.details);
        throw error;
      }
      const before = await tx.getOverrides();
      await tx.setOverrides(overrides as Record<string, unknown>);
      await tx.appendAudit({
        actor: principalOf(res).actor,
        type: "settings.changed",
        subject: tenantId,
        data: { before: before as Json, after: overrides as Json },
      });
      return { overrides, tools: toolset.describe() };
    });
    res.json(resolved);
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof OpsdeskError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(422).json({ error: { code: "validation_failed", message: "Invalid request", details: error.issues } });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ error: { code: "bad_json", message: "Request body is not valid JSON" } });
      return;
    }
    console.error(error);
    res.status(500).json({ error: { code: "internal", message: "Internal error" } });
  });

  return router;
}
