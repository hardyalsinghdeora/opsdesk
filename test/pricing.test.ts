import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "../src/core/errors.ts";
import { formatMinor, priceQuote, type PriceListItem } from "../src/tools/pricing.ts";

const list: PriceListItem[] = [
  { code: "A", name: "Thing A", unit: "unit", unit_price: 180, aliases: [] },
  { code: "B", name: "Thing B", unit: "hour", unit_price: 99.99, aliases: [] },
];

describe("pricing", () => {
  it("prices lines in minor units and adds tax", () => {
    const q = priceQuote([{ code: "A", quantity: 3 }, { code: "B", quantity: 1 }], list, 0.05, "AED");
    assert.equal(q.subtotalMinor, 54_000 + 9_999);
    assert.equal(q.taxMinor, Math.round(63_999 * 0.05));
    assert.equal(q.totalMinor, q.subtotalMinor + q.taxMinor);
  });

  it("avoids floating point drift", () => {
    const q = priceQuote([{ code: "B", quantity: 3 }], list, 0, "USD");
    assert.equal(q.totalMinor, 29_997); // 99.99 * 3 in floats is 299.96999...
  });

  it("supports fractional quantities such as hours", () => {
    const q = priceQuote([{ code: "B", quantity: 1.5 }], list, 0, "USD");
    assert.equal(q.totalMinor, Math.round(9_999 * 1.5));
  });

  it("refuses unknown codes, empty quotes and non-positive quantities", () => {
    assert.throws(() => priceQuote([{ code: "Z", quantity: 1 }], list, 0, "USD"), ValidationError);
    assert.throws(() => priceQuote([], list, 0, "USD"), ValidationError);
    assert.throws(() => priceQuote([{ code: "A", quantity: 0 }], list, 0, "USD"), ValidationError);
  });

  it("formats in the company currency", () => {
    assert.equal(formatMinor(82_950, "AED", "en"), "AED 829.50");
  });
});
