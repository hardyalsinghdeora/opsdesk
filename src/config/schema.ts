import { z } from "zod";

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes");
const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "snake_case key");
const toolName = z.string().regex(/^[a-z]+\.[a-z_]+$/, "tool names look like area.verb_noun");
const workflowKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "snake_case workflow id");
const secretRef = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "the NAME of an environment variable holding the secret");

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
/** The company-wide default. "never" is per tool only: as a default it would switch everything off. */
export const ApprovalPolicy = z.enum(["required", "auto"]);
/** Per tool: run on its own, wait for a person, or never run at all. */
export const ToolApproval = z.enum(["auto", "required", "never"]);
export type ToolApproval = z.infer<typeof ToolApproval>;

export const ToolEntry = z
  .object({
    enabled: z.boolean().default(false),
    /** Overrides `approvals.default` for this tool. Ignored for read-only tools. */
    approval: ToolApproval.optional(),
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

/** A workflow step may only make its tool stricter, so "auto" is not accepted here. */
export const StepApproval = z.enum(["required", "never"]);

export const WorkflowStep = z.object({ tool: toolName, approval: StepApproval.optional() }).strict();

/**
 * One business process: what starts it, who owns it, and the tools it runs
 * in order. A company runs many; each switches on and off on its own.
 */
export const Workflow = z
  .object({
    enabled: z.boolean().default(false),
    description: z.string().min(1),
    /** Lower runs first when an incoming item matches more than one workflow. */
    priority: z.number().int().min(0).max(1000).default(100),
    trigger: z
      .object({
        channel: z.enum(["email", "form", "call", "schedule", "manual"]),
        /** The intent label from intake that starts this workflow, e.g. "quote". */
        intent: z.string().min(1).optional(),
      })
      .strict(),
    /** Who answers for it: a person's email or a role. */
    owner: z.string().min(1),
    steps: z.array(WorkflowStep).min(1),
  })
  .strict();
export type Workflow = z.infer<typeof Workflow>;

const fake = z.object({ kind: z.literal("fake") }).strict();

/**
 * External systems, one entry per role. Secrets are never written here: a
 * `*_ref` names the environment variable that holds them on the server.
 */
export const Connectors = z
  .object({
    mailbox: z
      .discriminatedUnion("kind", [
        fake,
        z
          .object({
            kind: z.literal("gmail"),
            address: z.email(),
            client_id_ref: secretRef,
            client_secret_ref: secretRef,
            refresh_token_ref: secretRef,
          })
          .strict(),
        z.object({ kind: z.literal("m365"), address: z.email() }).strict(),
      ])
      .optional(),
    crm: z
      .discriminatedUnion("kind", [
        fake,
        z
          .object({
            kind: z.literal("zoho_crm"),
            /** Where the Zoho account lives: com, eu, in, com.au, jp, ca, sa or com.cn. */
            data_center: z.enum(["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn"]),
            module: z.enum(["Leads", "Contacts"]).default("Leads"),
            client_id_ref: secretRef,
            client_secret_ref: secretRef,
            refresh_token_ref: secretRef,
          })
          .strict(),
        z.object({ kind: z.literal("hubspot"), token_ref: secretRef }).strict(),
      ])
      .optional(),
    accounting: z
      .discriminatedUnion("kind", [fake, z.object({ kind: z.literal("zoho_books"), organization_id: z.string().min(1) }).strict()])
      .optional(),
    /** The company's own application, reached only through the operations listed. */
    app: z
      .object({
        kind: z.literal("rest"),
        base_url: z.url(),
        secret_ref: secretRef,
        operations: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
                method: z.enum(["GET", "POST"]),
                path: z.string().startsWith("/"),
                description: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    /** The company's database: read-only, and only the tables or views listed. */
    database: z
      .object({
        kind: z.literal("sql"),
        dialect: z.enum(["postgres", "mysql", "mssql"]),
        url_ref: secretRef,
        allowed_tables: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Connectors = z.infer<typeof Connectors>;

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
    workflows: z.record(workflowKey, Workflow).default({}),
    connectors: Connectors.default({}),
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
 * Deliberately narrow: switches and thresholds, never prices, prompts or connectors.
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
      .record(toolName, z.object({ enabled: z.boolean().optional(), approval: ToolApproval.optional() }).strict())
      .optional(),
    workflows: z.record(workflowKey, z.object({ enabled: z.boolean().optional() }).strict()).optional(),
  })
  .strict();
export type RuntimeOverrides = z.infer<typeof RuntimeOverrides>;
