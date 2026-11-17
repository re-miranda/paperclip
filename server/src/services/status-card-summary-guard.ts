import { unprocessable } from "../errors.js";

/** The slice of an update task's `ownerAttention` payload the write-back guard needs. */
export type ListedAttentionItem = { itemId: string; identifier: string | null };

const IDENTIFIER_CHARS = "A-Za-z0-9-";

function mentionsIdentifier(markdown: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Lookarounds keep "MIR-37" from matching inside "MIR-374".
  return new RegExp(`(?<![${IDENTIFIER_CHARS}])${escaped}(?![${IDENTIFIER_CHARS}])`).test(markdown);
}

/**
 * Reads the listed owner Attention items out of an update task's JSON payload.
 * Anything not shaped like `{ owner: "user", items: [...] }` (compile tasks,
 * agent-created cards, older tasks) yields an empty list, so no guard applies.
 *
 * @example
 * listedAttentionItems({ ownerAttention: { owner: "user", items: [{ itemId: "a", identifier: "MIR-374" }] } });
 */
export function listedAttentionItems(payload: Record<string, unknown> | null): ListedAttentionItem[] {
  const attention = payload?.ownerAttention as { owner?: unknown; items?: unknown } | undefined;
  if (attention?.owner !== "user" || !Array.isArray(attention.items)) return [];
  return attention.items.filter((item): item is ListedAttentionItem => typeof item?.itemId === "string");
}

/**
 * Rejects a status-card summary that leaves out a listed Attention item, so a
 * card cannot silently drop what holds up its work (MIR-376). Items without an
 * issue identifier cannot be matched in text and are not required.
 *
 * @example
 * assertSummaryListsAttentionItems("# Waiting on you\n- MIR-374", [{ itemId: "a", identifier: "MIR-374" }]);
 */
export function assertSummaryListsAttentionItems(markdown: string, items: ListedAttentionItem[]): void {
  const missing = items
    .map((item) => item.identifier)
    .filter((identifier): identifier is string => !!identifier && !mentionsIdentifier(markdown, identifier));
  if (missing.length === 0) return;
  throw unprocessable(
    `Summary omits listed Attention item(s): ${[...new Set(missing)].join(", ")}. `
    + 'Expected the summary to open with every item under "Waiting on the card owner", by issue identifier (e.g. MIR-374), in the given order.',
  );
}
