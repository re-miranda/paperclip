import { describe, expect, it } from "vitest";
import { assertSummaryListsAttentionItems, listedAttentionItems } from "../services/status-card-summary-guard.js";

const ITEMS = [
  { itemId: "a", identifier: "MIR-374" },
  { itemId: "b", identifier: "MIR-133" },
];

describe("status card summary write-back guard", () => {
  it("accepts a summary that names every listed item", () => {
    expect(() => assertSummaryListsAttentionItems("- MIR-374 first\n- [MIR-133](/MIR/issues/MIR-133)", ITEMS)).not.toThrow();
  });

  it("rejects a summary that omits an item and names it with the expected shape", () => {
    expect(() => assertSummaryListsAttentionItems("- MIR-374 only", ITEMS)).toThrow(/omits listed Attention item\(s\): MIR-133\. Expected/);
  });

  it("names every missing identifier once", () => {
    expect(() => assertSummaryListsAttentionItems("Nothing is waiting on you.", [...ITEMS, ITEMS[0]!])).toThrow(/MIR-374, MIR-133\./);
  });

  it("does not count a longer identifier as a mention of a shorter one", () => {
    expect(() => assertSummaryListsAttentionItems("MIR-3741 and MIR-1330", ITEMS)).toThrow(/MIR-374, MIR-133/);
  });

  it("accepts any summary when the list is empty", () => {
    expect(() => assertSummaryListsAttentionItems("Nothing waits.", [])).not.toThrow();
  });

  it("does not require items that have no identifier", () => {
    expect(() => assertSummaryListsAttentionItems("Summary.", [{ itemId: "c", identifier: null }])).not.toThrow();
  });

  it("reads the list from an update payload and ignores other payloads", () => {
    expect(listedAttentionItems({ ownerAttention: { owner: "user", items: ITEMS, elsewhereCount: 0 } })).toEqual(ITEMS);
    expect(listedAttentionItems({ ownerAttention: { owner: "none" } })).toEqual([]);
    expect(listedAttentionItems({ operation: "compile" })).toEqual([]);
    expect(listedAttentionItems(null)).toEqual([]);
  });
});
