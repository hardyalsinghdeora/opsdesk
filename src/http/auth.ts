import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ForbiddenError, OpsdeskError } from "../core/errors.ts";

export const Role = z.enum(["ingest", "operator", "admin"]);
export type Role = z.infer<typeof Role>;

export interface Principal {
  tenantId: string;
  actor: string;
  role: Role;
}

const KeyEntry = z.object({ key: z.string().min(16), tenant: z.string(), actor: z.string().min(1), role: Role }).strict();

const digest = (key: string) => createHash("sha256").update(key).digest("hex");

/** API keys, held only as hashes. */
export class ApiKeys {
  private readonly byHash = new Map<string, Principal>();

  add(key: string, principal: Principal): void {
    this.byHash.set(digest(key), principal);
  }

  lookup(key: string): Principal | undefined {
    return this.byHash.get(digest(key));
  }

  /** Parse OPSDESK_API_KEYS: a JSON array of {key, tenant, actor, role}. */
  static fromJson(raw: string): ApiKeys {
    const entries = z.array(KeyEntry).parse(JSON.parse(raw));
    const keys = new ApiKeys();
    for (const e of entries) keys.add(e.key, { tenantId: e.tenant, actor: e.actor, role: e.role });
    return keys;
  }

  /** Random keys for local development, one per tenant and role. */
  static forDevelopment(tenantIds: string[]): { keys: ApiKeys; listing: (Principal & { key: string })[] } {
    const keys = new ApiKeys();
    const listing: (Principal & { key: string })[] = [];
    for (const tenantId of tenantIds) {
      for (const role of Role.options) {
        const key = `dev_${tenantId}_${role}_${randomBytes(9).toString("base64url")}`;
        const principal = { tenantId, actor: `${role}@${tenantId}.dev`, role };
        keys.add(key, principal);
        listing.push({ ...principal, key });
      }
    }
    return { keys, listing };
  }
}

export function authenticate(keys: ApiKeys) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const principal = match?.[1] ? keys.lookup(match[1]) : undefined;
    if (!principal) {
      next(new OpsdeskError(401, "unauthenticated", "Missing or unknown API key"));
      return;
    }
    // A key for one company cannot see that another company exists.
    if (req.params.tenant !== principal.tenantId) {
      next(new OpsdeskError(404, "not_found", "Not found"));
      return;
    }
    res.locals.principal = principal;
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const principal = res.locals.principal as Principal | undefined;
    if (!principal || !roles.includes(principal.role)) {
      next(new ForbiddenError(`Requires role: ${roles.join(" or ")}`));
      return;
    }
    next();
  };
}
