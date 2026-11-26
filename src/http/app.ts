import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, NextFunction, Request, Response } from "express";
import { bearerToken, can, hashToken, type Principal } from "../auth/principal.ts";
import { buildMcpServer } from "../mcp/server.ts";
import { scopeFor, type Runtime } from "../runtime.ts";

export interface AppOptions {
  /** Interface to bind; localhost enables the SDK's DNS-rebinding protection. */
  host?: string;
  /** Host names the server answers to, e.g. the hostname of OPSDESK_PUBLIC_URL. */
  allowedHosts?: string[];
}

const rpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

/**
 * The whole HTTP surface: a health check and one MCP endpoint. There is no
 * other API; people work through Claude Code, administrators through the
 * aiops command line on the server.
 */
export function createApp(rt: Runtime, options: AppOptions = {}): Express {
  const app = createMcpExpressApp({ host: options.host ?? "127.0.0.1", allowedHosts: options.allowedHosts });
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, store: rt.store.kind, extractor: rt.extractor.name });
  });

  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req.get("authorization"));
      const who = token ? await rt.store.resolveToken(hashToken(token)) : null;
      // A company removed from the server's packs keeps its rows, but nobody can sign in to it.
      if (!who || !rt.source.packs.has(who.tenantId)) {
        res.set("WWW-Authenticate", 'Bearer realm="opsdesk"');
        rpcError(res, 401, "Missing, unknown or revoked token");
        return;
      }
      if (!can(who.role, "read")) {
        rpcError(res, 403, "This account cannot use opsdesk");
        return;
      }
      res.locals.principal = who;
      next();
    } catch (error) {
      next(error);
    }
  };

  app.post("/mcp", authenticate, async (req, res) => {
    const who = res.locals.principal as Principal;
    try {
      const snapshot = await rt.store.withTenant(who.tenantId, (tx) => scopeFor(rt, tx));
      const server = buildMcpServer(rt, who, snapshot);
      // Stateless: a fresh server and transport per request, so config changes apply to the next call.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) rpcError(res, 500, "Internal error");
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}
