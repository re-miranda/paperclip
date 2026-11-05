import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import type { AttentionItem, AttentionSourceKind, CompanySearchIssueSummary } from "@paperclipai/shared";
import { attentionService } from "./attention.js";
import { attentionItemIssueIds } from "./decision-queues.js";
import { walkExplicitBlockerGraph } from "./issues.js";
import { companyVisibleIssueIds, listableAttentionItemIds } from "./status-card-privacy.js";
import type { StatusCardFingerprint } from "./status-card-update-engine.js";

/**
 * MIR-376: a status card opens with the owner's open Attention items that hold
 * up the card's work, most work held up first. The platform ranks; the
 * summarizer only writes it up.
 */

/** Upper bound on upstream blockers joined to a card's watched set. */
export const STATUS_CARD_MAX_BLOCKER_ISSUES = 200;

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export type StatusCardAttentionEntry = {
  itemId: string;
  title: string | null;
  sourceKind: AttentionSourceKind;
  href: string | null;
  /** Watched issue the item sits on. */
  issueId: string;
  identifier: string | null;
  /** How many of the card's open issues wait on this item. */
  holdsUpCount: number;
  heldUpIdentifiers: string[];
};

export type StatusCardOwnerAttention =
  | { owner: "none" }
  | {
    owner: "user";
    userId: string;
    items: StatusCardAttentionEntry[];
    elsewhereCount: number;
    attentionHref: string;
  };

/** Loads one user's Attention desk items, already in the desk's own order. */
export type OwnerAttentionLoader = (companyId: string, userId: string) => Promise<AttentionItem[]>;

/**
 * The card's own issues plus the upstream blockers they wait on. Only issues
 * every company member can read take part: the update task and the stored
 * fingerprint are readable company-wide, so private blockers and the
 * Attention items on them must never reach either (MIR-391).
 */
export type StatusCardBlockerChain = {
  /** Issue id -> ids of the unresolved issues blocking it, both company-visible. */
  edgesByIssueId: Map<string, string[]>;
  /** Company-visible upstream blockers that are not card issues. */
  blockerIssueIds: string[];
  /** Company-visible card issues and blockers: the owner block's whole scope. */
  visibleIssueIds: Set<string>;
};

export type WatchedIssueRef = Pick<CompanySearchIssueSummary, "id" | "identifier" | "status">;

/**
 * Reads the owner's items exactly as their Attention desk does: same service,
 * same read permissions, dismissed and snoozed items left out.
 *
 * @example
 * const items = await ownerAttentionLoader(db)(companyId, card.createdByUserId);
 */
export function ownerAttentionLoader(db: Db): OwnerAttentionLoader {
  const attention = attentionService(db);
  return async (companyId, userId) => {
    const feed = await attention.list(companyId, {
      userId,
      actor: { type: "board", userId },
      all: true,
      allowUnscopedAll: true,
    });
    return feed.items;
  };
}

/**
 * Shares one Attention read per owner across the cards of one scheduler tick.
 *
 * @example
 * const load = memoizeOwnerAttentionLoader(ownerAttentionLoader(db));
 */
export function memoizeOwnerAttentionLoader(load: OwnerAttentionLoader): OwnerAttentionLoader {
  const cache = new Map<string, Promise<AttentionItem[]>>();
  return (companyId, userId) => {
    const key = `${companyId}:${userId}`;
    const cached = cache.get(key) ?? load(companyId, userId);
    cache.set(key, cached);
    return cached;
  };
}

/** Drops every edge that touches an issue outside `allowed`. */
function pruneBlockerEdges(edgesByIssueId: ReadonlyMap<string, string[]>, allowed: ReadonlySet<string>): Map<string, string[]> {
  const pruned = new Map<string, string[]>();
  for (const [issueId, blockerIds] of edgesByIssueId) {
    if (!allowed.has(issueId)) continue;
    pruned.set(issueId, blockerIds.filter((blockerId) => allowed.has(blockerId)));
  }
  return pruned;
}

/**
 * Walks "blocked by" links upstream from the card's open, company-visible
 * issues with the issue service's blocker walk, capped at
 * STATUS_CARD_MAX_BLOCKER_ISSUES new issues. Private issues end the chain.
 *
 * @example
 * const chain = await readStatusCardBlockerChain(db, companyId, cardIssues);
 */
export async function readStatusCardBlockerChain(
  db: Db,
  companyId: string,
  cardIssues: CompanySearchIssueSummary[],
): Promise<StatusCardBlockerChain> {
  const visibleCardIds = await companyVisibleIssueIds(db, companyId, cardIssues.map((issue) => issue.id));
  const roots = cardIssues.filter((issue) => visibleCardIds.has(issue.id) && !CLOSED_ISSUE_STATUSES.has(issue.status));
  const graph = await walkExplicitBlockerGraph(companyId, roots, db, { maxNodes: roots.length + STATUS_CARD_MAX_BLOCKER_ISSUES });
  const cardIssueIds = new Set(cardIssues.map((issue) => issue.id));
  const candidateIds = [...graph.nodesById.keys()].filter((issueId) => !cardIssueIds.has(issueId));
  const allowed = new Set([...visibleCardIds, ...await companyVisibleIssueIds(db, companyId, candidateIds)]);
  const edgesByIssueId = pruneBlockerEdges(graph.edgesByIssueId, allowed);
  const reachable = new Set(roots.flatMap((root) => [...upstreamIssueIds(root.id, edgesByIssueId)]));
  const blockerIssueIds = [...reachable].filter((issueId) => !cardIssueIds.has(issueId));
  return { edgesByIssueId, blockerIssueIds, visibleIssueIds: new Set([...visibleCardIds, ...blockerIssueIds]) };
}

/**
 * The issue itself plus everything it waits on through blocker edges.
 *
 * @example
 * upstreamIssueIds("b", new Map([["b", ["a"]]])); // Set {"b", "a"}
 */
export function upstreamIssueIds(rootId: string, edgesByIssueId: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    for (const blockerId of edgesByIssueId.get(stack.pop()!) ?? []) {
      if (seen.has(blockerId)) continue;
      seen.add(blockerId);
      stack.push(blockerId);
    }
  }
  return seen;
}

export type StatusCardAttentionRankInput = {
  items: AttentionItem[];
  cardIssues: WatchedIssueRef[];
  watchedIssues: ReadonlyMap<string, WatchedIssueRef>;
  edgesByIssueId: ReadonlyMap<string, string[]>;
  /** Items that passed the privacy rules in status-card-privacy.ts; only these may be listed. */
  listableItemIds: ReadonlySet<string>;
  /** Company issue prefix, for links built from the watched issue an item sits on. */
  issuePrefix: string;
};

type RankedEntry = { entry: StatusCardAttentionEntry; deskRank: number };

function heldUpIssues(anchors: string[], closures: Array<{ issue: WatchedIssueRef; ids: Set<string> }>): WatchedIssueRef[] {
  return closures
    .filter((closure) => anchors.some((anchor) => closure.ids.has(anchor)))
    .map((closure) => closure.issue);
}

function toRankedEntry(item: AttentionItem, issue: WatchedIssueRef, heldUp: WatchedIssueRef[], issuePrefix: string): RankedEntry {
  return {
    deskRank: item.rank,
    entry: {
      itemId: item.id,
      title: item.subject.title,
      sourceKind: item.sourceKind,
      // Built from the watched issue, never the item's own link, which may target a private issue (MIR-396).
      href: `/${issuePrefix}/issues/${issue.identifier ?? issue.id}`,
      issueId: issue.id,
      identifier: issue.identifier,
      holdsUpCount: heldUp.length,
      heldUpIdentifiers: heldUp.map((held) => held.identifier ?? held.id),
    },
  };
}

function compareRankedEntries(left: RankedEntry, right: RankedEntry): number {
  const weightDiff = right.entry.holdsUpCount - left.entry.holdsUpCount;
  return weightDiff !== 0 ? weightDiff : left.deskRank - right.deskRank;
}

/**
 * Keeps the owner's items that sit on a watched issue (the card's issues or
 * their blocker chain), ranked by how many of the card's open issues each
 * holds up, then by the Attention desk's own order. The rest only count,
 * including every item outside `listableItemIds`, so no private title or link
 * reaches the company-readable update task (MIR-394, MIR-396).
 *
 * @example
 * rankStatusCardOwnerAttention({ items, cardIssues, watchedIssues, edgesByIssueId, listableItemIds, issuePrefix: "MIR" });
 * // { items: [{ identifier: "MIR-374", holdsUpCount: 2, ... }], elsewhereCount: 3 }
 */
export function rankStatusCardOwnerAttention(
  input: StatusCardAttentionRankInput,
): { items: StatusCardAttentionEntry[]; elsewhereCount: number } {
  const closures = input.cardIssues
    .filter((issue) => !CLOSED_ISSUE_STATUSES.has(issue.status))
    .map((issue) => ({ issue, ids: upstreamIssueIds(issue.id, input.edgesByIssueId) }));
  const ranked: RankedEntry[] = [];
  let elsewhereCount = 0;
  for (const item of input.items) {
    const anchors = attentionItemIssueIds(item);
    const watched = anchors.map((anchor) => input.watchedIssues.get(anchor)).find(Boolean);
    if (!watched || !input.listableItemIds.has(item.id)) {
      elsewhereCount += 1;
      continue;
    }
    ranked.push(toRankedEntry(item, watched, heldUpIssues(anchors, closures), input.issuePrefix));
  }
  return { items: ranked.sort(compareRankedEntries).map(({ entry }) => entry), elsewhereCount };
}

/**
 * Stores each listed item's id on the watched issue it sits on, so the next
 * fingerprint diff sees items appear and resolve without a new column.
 *
 * @example
 * attachOwnerAttention(fingerprint, attention)[issueId].attentionItemIds; // ["<item id>"]
 */
export function attachOwnerAttention(
  fingerprint: StatusCardFingerprint,
  attention: StatusCardOwnerAttention,
): StatusCardFingerprint {
  if (attention.owner === "none") return fingerprint;
  const next: StatusCardFingerprint = { ...fingerprint };
  for (const item of attention.items) {
    const entry = next[item.issueId];
    if (!entry) continue;
    const itemIds = [...(entry.attentionItemIds ?? []), item.itemId].sort();
    next[item.issueId] = { ...entry, attentionItemIds: itemIds };
  }
  return next;
}

async function companyIssuePrefix(db: Db, companyId: string): Promise<string> {
  const company = await db.select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return company?.issuePrefix ?? "PAP";
}

export type StatusCardOwnerAttentionInput = {
  db: Db;
  load: OwnerAttentionLoader;
  card: { companyId: string; createdByUserId: string | null };
  cardIssues: WatchedIssueRef[];
  watchedIssues: WatchedIssueRef[];
  edgesByIssueId: ReadonlyMap<string, string[]>;
};

/**
 * The "waiting on you" block for one card. Agent-created cards have no owner
 * and skip it.
 *
 * @example
 * await computeStatusCardOwnerAttention({ db, load, card, cardIssues, watchedIssues, edgesByIssueId });
 */
export async function computeStatusCardOwnerAttention(input: StatusCardOwnerAttentionInput): Promise<StatusCardOwnerAttention> {
  const userId = input.card.createdByUserId;
  if (!userId) return { owner: "none" };
  const [items, issuePrefix] = await Promise.all([
    input.load(input.card.companyId, userId),
    companyIssuePrefix(input.db, input.card.companyId),
  ]);
  const watchedIssues = new Map(input.watchedIssues.map((issue) => [issue.id, issue]));
  const ranked = rankStatusCardOwnerAttention({
    items,
    cardIssues: input.cardIssues,
    watchedIssues,
    edgesByIssueId: input.edgesByIssueId,
    listableItemIds: await listableAttentionItemIds(input.db, input.card.companyId, items, new Set(watchedIssues.keys())),
    issuePrefix,
  });
  return { owner: "user", userId, attentionHref: `/${issuePrefix}/decisions`, ...ranked };
}
