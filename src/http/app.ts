import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Express, NextFunction, Request, Response } from "express";
import { bearerToken, can, hashToken, type Principal } from "../auth/principal.ts";
import { createMcpSession, type McpSession } from "../mcp/server.ts";
import { scopeFor, type Runtime } from "../runtime.ts";

export interface AppOptions {
  /** Interface to bind; localhost enables the SDK's DNS-rebinding protection. */
  host?: string;
  /** Host names the server answers to, e.g. the hostname of OPSDESK_PUBLIC_URL. */
  allowedHosts?: string[];
  /** Close a session after this long without a request. Default 30 minutes. */
  sessionIdleMs?: number;
  /** Most sessions one person may hold at once; the oldest closes first. Default 10. */
  maxSessionsPerPerson?: number;
}

interface Session extends McpSession {
  transport: StreamableHTTPServerTransport;
  who: Principal;
  lastSeen: number;
}

const rpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

/**
 * The whole HTTP surface: a health check and one MCP endpoint. People work
 * through Claude Code; administrators use the aiops command line.
 *
 * Sessions exist so the server can ask a person a question mid-call (an
 * approval prompt) and receive the answer. They hold no authority: the token
 * is checked on every request and must belong to the session's own person,
 * and each request re-reads the company's config.
 */
export function createApp(rt: Runtime, options: AppOptions = {}): Express {
  const app = createMcpExpressApp({ host: options.host ?? "127.0.0.1", allowedHosts: options.allowedHosts });
  app.disable("x-powered-by");
  const idleMs = options.sessionIdleMs ?? 30 * 60_000;
  const maxPerPerson = options.maxSessionsPerPerson ?? 10;
  const sessions = new Map<string, Session>();

  const close = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close();
    void s.server.close();
  };
  // unref: the sweep never keeps the process alive on its own.
  setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) close(id);
  }, Math.min(idleMs, 60_000)).unref();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, store: rt.store.kind, extractor: rt.extractor.name, sessions: sessions.size });
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

  /** The caller's own session, or null after answering 404. Another person's session id is treated as unknown. */
  const ownSession = (req: Request, res: Response): Session | null => {
    const who = res.locals.principal as Principal;
    const id = req.get("mcp-session-id");
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.who.staffId !== who.staffId) {
      rpcError(res, 404, "Session not found; reconnect");
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  };

  app.post("/mcp", authenticate, async (req, res) => {
    const who = res.locals.principal as Principal;
    try {
      const snapshot = await rt.store.withTenant(who.tenantId, (tx) => scopeFor(rt, tx));

      if (req.get("mcp-session-id")) {
        const s = ownSession(req, res);
        if (!s) return;
        s.refresh(snapshot);
        await s.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        rpcError(res, 400, "Start a session first (initialize)");
        return;
      }

      const mine = [...sessions].filter(([, s]) => s.who.staffId === who.staffId).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [id] of mine.slice(0, Math.max(0, mine.length - maxPerPerson + 1))) close(id);

      const mcp = createMcpSession(rt, who, snapshot);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { ...mcp, transport, who, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcp.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) rpcError(res, 500, "Internal error");
    }
  });

  // The stream the server uses to send a person a question, and the end of a session.
  const existing = async (req: Request, res: Response) => {
    const s = ownSession(req, res);
    if (!s) return;
    try {
      await s.transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) rpcError(res, 500, "Internal error");
    }
  };
  app.get("/mcp", authenticate, existing);
  app.delete("/mcp", authenticate, existing);

  return app;
}
