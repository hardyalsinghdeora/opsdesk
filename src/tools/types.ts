import type { z } from "zod";
import type { CompanyConfig, ToolApproval } from "../config/schema.ts";
import type { Json } from "../core/json.ts";
import type { TenantTx } from "../store/types.ts";
import type { Connectors } from "../connectors/types.ts";

export interface ToolContext<S> {
  tenantId: string;
  config: CompanyConfig;
  settings: S;
  tx: TenantTx;
  now: Date;
  /** Who is causing the effect: the approver for approved actions. */
  actor: string;
  /** The company's external systems (CRM, mailbox, ...). */
  connectors: Connectors;
}

/**
 * One capability the platform can perform for a company. Tools are plain
 * modules; a company turns them on in its pack, and a disabled tool is never
 * described to the model and is refused by the gateway.
 */
export interface ToolDefinition<I = any, S = any> {
  name: string;
  /** One line shown in prompts and to operators. */
  summary: string;
  /** Read tools run at once. Write tools go through the approval policy. */
  effect: "read" | "write";
  inputSchema: z.ZodType<I>;
  settingsSchema: z.ZodType<S>;
  /** Deterministic, side-effect free. Shown to the approver before they decide. */
  preview?(ctx: Omit<ToolContext<S>, "actor" | "connectors">, input: I): Json | Promise<Json>;
  execute(ctx: ToolContext<S>, input: I): Promise<Json>;
}

export interface EnabledTool {
  tool: ToolDefinition;
  settings: unknown;
  approval: ToolApproval;
}
