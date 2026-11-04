import type { StatusCardOwnerAttention } from "./status-card-owner-attention.js";

type UntrustedBlock = (label: string, value: unknown) => string;

const NO_OWNER_SECTION = "An agent created this card, so it has no owner and no \"waiting on you\" block. Say so in one short line at the top of the summary.";

type OwnedAttention = Extract<StatusCardOwnerAttention, { owner: "user" }>;

function elsewhereLine(attention: OwnedAttention): string {
  if (attention.elsewhereCount === 0) return "";
  return ` End the summary with one line saying ${attention.elsewhereCount} other item(s) wait on the owner elsewhere, linking to ${attention.attentionHref}.`;
}

function ownerSectionText(attention: OwnedAttention): string {
  const lead = attention.items.length > 0
    ? "Open the summary with every item below, in this order, before anything else. Each is an open Attention item of the card owner that holds up this card's work, most work held up first. Never say nothing is waiting on the owner while this list has items."
    : "None of the card owner's open Attention items that this card may show holds up its work.";
  return `${lead}${elsewhereLine(attention)}`;
}

/**
 * The "Waiting on the card owner" section of a status-card update task. Item
 * titles are user content, so they go inside an untrusted-data block.
 *
 * @example
 * ownerAttentionPromptSection({ owner: "none" }, untrustedPromptBlock);
 */
export function ownerAttentionPromptSection(attention: StatusCardOwnerAttention, untrustedBlock: UntrustedBlock): string {
  const heading = "## Waiting on the card owner\n\n";
  if (attention.owner === "none") return `${heading}${NO_OWNER_SECTION}`;
  const items = attention.items.map(({ itemId, issueId, ...visible }) => visible);
  return `${heading}${ownerSectionText(attention)}\n\n${untrustedBlock("owner-attention", items)}`;
}

/**
 * The machine-readable copy for the task payload, so the summary write-back
 * can later check that every listed item made it into the Markdown.
 *
 * @example
 * ownerAttentionPayload(attention); // { owner: "user", items: [{ itemId, issueId, identifier }], elsewhereCount: 1 }
 */
export function ownerAttentionPayload(
  attention: StatusCardOwnerAttention,
): { owner: "none" } | { owner: "user"; items: Array<{ itemId: string; issueId: string; identifier: string | null }>; elsewhereCount: number } {
  if (attention.owner === "none") return { owner: "none" as const };
  return {
    owner: "user" as const,
    items: attention.items.map(({ itemId, issueId, identifier }) => ({ itemId, issueId, identifier })),
    elsewhereCount: attention.elsewhereCount,
  };
}
