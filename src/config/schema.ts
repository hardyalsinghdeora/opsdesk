import { z } from "zod";

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes");
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "snake_case key");
const toolName = z.string().regex(/^[a-z]+\.[a-z_]+$/, "tool names look like area.verb_noun");

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const ApprovalPolicy = z.enum(["required", "auto"]);

export const ToolEntry = z
  .object({
    enabled: z.boolean().default(false),
    /** Overrides `approvals.default` for this tool. Ignored for read-only tools. */
    approval: ApprovalPolicy.optional(),
    /** Validated by the tool's own settings schema when the tool is enabled. */
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const LeadField = z
  .object({
    key: fieldKey,
    label: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

/** The fully resolved config for one company: defaults + pack + runtime overrides. */
export const CompanyConfig = z
  .object({
    id: slug,
    name: z.string().min(1),
    industry: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code"),
    timezone: z.string().min(1),
    locale: z.string().min(2),
    llm: z
      .object({
        model: z.string().min(1),
        effort: Effort,
        max_tokens: z.number().int().positive(),
      })
      .strict(),
    approvals: z.object({ default: ApprovalPolicy }).strict(),
    channels: z
      .object({
        email: z
          .object({
            enabled: z.boolean(),
            min_confidence: z.number().min(0).max(1),
            addresses: z.array(z.string()).default([]),
          })
          .strict(),
      })
      .strict(),
    lead_fields: z.array(LeadField),
    tools: z.record(toolName, ToolEntry),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const [i, field] of cfg.lead_fields.entries()) {
      if (seen.has(field.key)) {
        ctx.addIssue({ code: "custom", path: ["lead_fields", i, "key"], message: `duplicate key ${field.key}` });
      }
      seen.add(field.key);
    }
  });
export type CompanyConfig = z.infer<typeof CompanyConfig>;

/**
 * Layer 3: what may change at runtime without a pack change and redeploy.
 * Deliberately narrow: switches and thresholds, never prices or prompts.
 */
export const RuntimeOverrides = z
  .object({
    approvals: z.object({ default: ApprovalPolicy }).strict().optional(),
    channels: z
      .object({
        email: z
          .object({
            enabled: z.boolean().optional(),
            min_confidence: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    tools: z
      .record(
        toolName,
        z.object({ enabled: z.boolean().optional(), approval: ApprovalPolicy.optional() }).strict(),
      )
      .optional(),
  })
  .strict();
export type RuntimeOverrides = z.infer<typeof RuntimeOverrides>;
