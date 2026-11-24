import { z } from "zod";
import type { ToolDefinition } from "./types.ts";

const nullableString = z.string().trim().min(1).nullable();

const Input = z
  .object({
    contact: z
      .object({
        name: nullableString,
        email: z.string().email().nullable(),
        phone: nullableString,
        company: nullableString,
      })
      .strict(),
    summary: z.string().min(1).max(2000),
    urgency: z.enum(["low", "normal", "high"]),
    custom_fields: z.record(z.string(), z.string().nullable()).default({}),
    source: z.string().min(1),
    source_ref: z.string().nullable().default(null),
  })
  .strict();

const Settings = z
  .object({
    default_stage: z.string().min(1).default("new"),
    owner: z.string().min(1).optional(),
  })
  .strict();

export const crmCreateLead: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Settings>> = {
  name: "crm.create_lead",
  summary: "Create a lead in the CRM from an inbound enquiry",
  effect: "write",
  inputSchema: Input,
  settingsSchema: Settings,
  preview(ctx, input) {
    const allowed = new Set(ctx.config.lead_fields.map((f) => f.key));
    return {
      contact: input.contact,
      stage: ctx.settings.default_stage,
      owner: ctx.settings.owner ?? null,
      custom_fields: Object.fromEntries(Object.entries(input.custom_fields).filter(([k]) => allowed.has(k))),
    };
  },
  async execute(ctx, input) {
    // Only keys the company declared are stored, whatever the caller sent.
    const allowed = new Set(ctx.config.lead_fields.map((f) => f.key));
    const customFields = Object.fromEntries(
      Object.entries(input.custom_fields).filter(([key]) => allowed.has(key)),
    );
    const lead = await ctx.tx.insertLead({
      contact: input.contact,
      summary: input.summary,
      stage: ctx.settings.default_stage,
      owner: ctx.settings.owner ?? null,
      urgency: input.urgency,
      customFields,
      source: input.source,
      sourceRef: input.source_ref,
    });
    return { lead_id: lead.id };
  },
};
