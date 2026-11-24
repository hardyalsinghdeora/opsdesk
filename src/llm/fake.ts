import { ExtractionError, normaliseExtraction, type ExtractionRequest, type ExtractionResult, type Extractor } from "./extraction.ts";

const SIMULATE = /\[\[simulate:(refusal|invalid)\]\]/;
const NOT_BUSINESS = /\b(unsubscribe|newsletter|out of office|auto-?reply)\b/i;
const QUOTE_WORDS = /\b(quote|quotation|price|pricing|cost|how much|estimate)\b/i;
const URGENT = /\b(urgent|asap|emergency|immediately|today)\b/i;

/**
 * Deterministic stand-in for the model, for tests, the demo and offline
 * development. Simple keyword rules over the same request the real model
 * gets, so pipelines are exercised end to end without an API key.
 */
export class FakeExtractor implements Extractor {
  readonly name = "fake";

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const sim = SIMULATE.exec(request.user)?.[1];
    if (sim === "refusal") throw new ExtractionError("refusal", "Simulated refusal");
    if (sim === "invalid") throw new ExtractionError("invalid_output", "Simulated schema mismatch");

    const body = /<body>\n([\s\S]*)\n<\/body>/.exec(request.user)?.[1] ?? "";
    const from = /<from>(.*)<\/from>/.exec(request.user)?.[1] ?? "";
    const subject = /<subject>(.*)<\/subject>/.exec(request.user)?.[1] ?? "";
    const text = `${subject}\n${body}`;
    const lower = text.toLowerCase();

    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(from)?.[0] ?? null;
    const name = /(?:[Rr]egards|[Tt]hanks|[Cc]heers|[Bb]est),?\s*\n\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)/.exec(body)?.[1] ?? null;
    const phone = /(\+?\d[\d\s-]{7,}\d)/.exec(body)?.[1]?.trim() ?? null;
    const company = /\b(?:from|at)\s+([A-Z][\w&]*(?:\s[A-Z][\w&]*)*\s(?:LLC|Ltd|FZE|FZCO|Inc|GmbH))\b/.exec(body)?.[1] ?? null;

    const items: { service_code: string; description: string; quantity: number }[] = [];
    for (const entry of request.catalog) {
      for (const alias of entry.aliases) {
        const at = lower.indexOf(alias.toLowerCase());
        if (at === -1) continue;
        const before = lower.slice(Math.max(0, at - 24), at);
        const after = lower.slice(at + alias.length, at + alias.length + 24);
        const qty =
          /(\d+)\s*(?:x\s*)?(?:[a-z-]+\s){0,2}$/.exec(before)?.[1] ?? /^\s*(?:for|x)?\s*(\d+)\b/.exec(after)?.[1];
        items.push({ service_code: entry.code, description: alias, quantity: qty ? Number(qty) : 1 });
        break;
      }
    }

    const custom: Record<string, string | null> = {};
    for (const key of request.fieldKeys) {
      const m = new RegExp(`${key.replace(/_/g, "[ _]")}\\s*[:=-]\\s*([^\\n,.]+)`, "i").exec(text);
      custom[key] = m?.[1]?.trim() ?? null;
    }

    const filled = [email, name, phone].filter(Boolean).length;
    const confidence = Math.round(Math.min(0.95, 0.4 + filled * 0.15 + (items.length > 0 ? 0.1 : 0)) * 100) / 100;

    return {
      model: "fake-extractor",
      extraction: normaliseExtraction(
        {
          is_business_inquiry: !NOT_BUSINESS.test(text),
          contact: { name, email, phone, company },
          summary: subject || body.split("\n")[0] || "(no summary)",
          urgency: URGENT.test(text) ? "high" : "normal",
          confidence,
          custom_fields: custom,
          wants_quote: QUOTE_WORDS.test(text),
          items,
        },
        request,
      ),
    };
  }
}
