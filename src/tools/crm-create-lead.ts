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

    // One contact per person: match on email, then phone, before creating one.
    // A match only fills in what was missing; it never overwrites what a person entered.
    const existing = await ctx.tx.findContact({ email: input.contact.email, phone: input.contact.phone });
    let contact = existing;
    if (existing) {
      const missing = Object.fromEntries(
        (["name", "email", "phone", "company"] as const)
          .filter((key) => existing[key] === null && input.contact[key] !== null)
          .map((key) => [key, input.contact[key]]),
      );
      if (Object.keys(missing).length > 0) contact = await ctx.tx.updateContact(existing.id, missing);
    } else {
      contact = await ctx.tx.insertContact(input.contact);
    }
    if (!contact) throw new Error("contact could not be resolved");

    // Mirror into the company's CRM when one is connected. Idempotent there too
    // (upsert by email), so a retried action does not create a second record.
    let crm: { external_id: string; created: boolean } | null = null;
    if (ctx.connectors.crm) {
      const synced = await ctx.connectors.crm.upsertLead({
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        summary: input.summary,
        fields: customFields,
      });
      contact = await ctx.tx.updateContact(contact.id, { crmRef: synced.externalId });
      crm = { external_id: synced.externalId, created: synced.created };
    }

    const lead = await ctx.tx.insertLead({
      contactId: contact.id,
      contact: input.contact,
      summary: input.summary,
      stage: ctx.settings.default_stage,
      owner: ctx.settings.owner ?? null,
      urgency: input.urgency,
      customFields,
      source: input.source,
      sourceRef: input.source_ref,
    });
    return { lead_id: lead.id, contact_id: contact.id, existing_contact: existing !== null, crm };
  },
};
