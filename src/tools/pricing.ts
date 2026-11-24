import type { QuoteLine } from "../core/types.ts";
import { ValidationError } from "../core/errors.ts";

export interface PriceListItem {
  code: string;
  name: string;
  unit: string;
  unit_price: number;
  aliases: string[];
}

export interface PricedQuote {
  currency: string;
  lines: QuoteLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxRate: number;
}

/** Money is handled in minor units (fils, cents) so totals never drift. */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function formatMinor(minor: number, currency: string, locale = "en"): string {
  // Plain spaces: Intl uses non-breaking ones, which trip up emails and string comparisons.
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100).replace(/[\u00a0\u202f]/g, " ");
}

/**
 * Pure pricing. The model only maps free text to a catalogue code and a
 * quantity; every number on a quote comes from here.
 */
export function priceQuote(
  items: { code: string; quantity: number; note?: string | null }[],
  priceList: PriceListItem[],
  taxRate: number,
  currency: string,
): PricedQuote {
  if (items.length === 0) throw new ValidationError("A quote needs at least one line");
  const byCode = new Map(priceList.map((p) => [p.code, p]));
  const lines: QuoteLine[] = items.map((item) => {
    const entry = byCode.get(item.code);
    if (!entry) throw new ValidationError(`Unknown service code "${item.code}"`);
    if (!(item.quantity > 0)) throw new ValidationError(`Quantity for ${item.code} must be positive`);
    const unitPriceMinor = toMinor(entry.unit_price);
    return {
      code: entry.code,
      name: entry.name,
      unit: entry.unit,
      quantity: item.quantity,
      unitPriceMinor,
      lineTotalMinor: Math.round(unitPriceMinor * item.quantity),
      note: item.note ?? null,
    };
  });
  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const taxMinor = Math.round(subtotalMinor * taxRate);
  return { currency, lines, subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor, taxRate };
}
