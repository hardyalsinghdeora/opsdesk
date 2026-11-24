import { z } from "zod";
import type { Json } from "../core/json.ts";
import { formatMinor, priceQuote } from "./pricing.ts";
import type { ToolDefinition } from "./types.ts";

const Input = z
  .object({
    customer: z.object({ name: z.string().nullable(), email: z.string().email().nullable() }).strict(),
    items: z
      .array(
        z
          .object({
            code: z.string().min(1),
            quantity: z.number().positive().max(10_000),
            note: z.string().nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    source_ref: z.string().nullable().default(null),
  })
  .strict();

const PriceListItem = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]+$/),
    name: z.string().min(1),
    unit: z.string().min(1),
    unit_price: z.number().nonnegative(),
    aliases: z.array(z.string()).default([]),
  })
  .strict();

const Settings = z
  .object({
    tax_rate: z.number().min(0).max(1),
    valid_days: z.number().int().positive().default(14),
    price_list: z.array(PriceListItem).min(1),
  })
  .strict()
  .refine((s) => new Set(s.price_list.map((p) => p.code)).size === s.price_list.length, {
    message: "price_list codes must be unique",
  });

type Settings = z.infer<typeof Settings>;

function addDays(date: Date, days: number): string {
  const d = new Date(date.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export const quoteIssue: ToolDefinition<z.infer<typeof Input>, Settings> = {
  name: "quote.issue",
  summary: "Issue a priced quote from the company's price list",
  effect: "write",
  inputSchema: Input,
  settingsSchema: Settings,
  preview(ctx, input) {
    const priced = priceQuote(input.items, ctx.settings.price_list, ctx.settings.tax_rate, ctx.config.currency);
    const fmt = (minor: number) => formatMinor(minor, priced.currency, ctx.config.locale);
    return {
      customer: input.customer,
      currency: priced.currency,
      lines: priced.lines.map((l) => ({
        code: l.code,
        name: l.name,
        quantity: l.quantity,
        unit: l.unit,
        unit_price: fmt(l.unitPriceMinor),
        line_total: fmt(l.lineTotalMinor),
      })),
      subtotal: fmt(priced.subtotalMinor),
      tax: fmt(priced.taxMinor),
      total: fmt(priced.totalMinor),
      total_minor: priced.totalMinor,
      valid_until: addDays(ctx.now, ctx.settings.valid_days),
    } satisfies Json;
  },
  async execute(ctx, input) {
    // Re-price at execution time from current settings; never trust a stored total.
    const priced = priceQuote(input.items, ctx.settings.price_list, ctx.settings.tax_rate, ctx.config.currency);
    const quote = await ctx.tx.insertQuote({
      customer: input.customer,
      currency: priced.currency,
      lines: priced.lines,
      subtotalMinor: priced.subtotalMinor,
      taxMinor: priced.taxMinor,
      totalMinor: priced.totalMinor,
      taxRate: priced.taxRate,
      validUntil: addDays(ctx.now, ctx.settings.valid_days),
      sourceRef: input.source_ref,
    });
    return { quote_id: quote.id, number: quote.number, total_minor: quote.totalMinor };
  },
};
