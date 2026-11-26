import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Each team member has their own token and one role:
 * - viewer:   read records, workflows and the audit log
 * - staff:    viewer, plus ask for actions (which still go through approval)
 * - approver: staff, plus approve or reject actions
 * - owner:    approver, plus manage people and settings
 */
export const Role = z.enum(["viewer", "staff", "approver", "owner"]);
export type Role = z.infer<typeof Role>;

export type Permission = "read" | "request" | "approve" | "admin";

const GRANTS: Record<Role, readonly Permission[]> = {
  viewer: ["read"],
  staff: ["read", "request"],
  approver: ["read", "request", "approve"],
  owner: ["read", "request", "approve", "admin"],
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

/** Who is calling, resolved from their token. Always bound to exactly one company. */
export interface Principal {
  tenantId: string;
  staffId: string;
  /** The person's email, written to the audit log as the actor. */
  actor: string;
  role: Role;
}

const TOKEN_PREFIX = "ods_";

/** A new personal token. Shown once; only its hash is stored. */
export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Pulls the token from an `Authorization: Bearer ...` header value. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  const token = match?.[1];
  return token && token.startsWith(TOKEN_PREFIX) ? token : null;
}
