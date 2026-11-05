import { and, eq, inArray, type SQL } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import { issueReadSqlCondition } from "./authorization.js";
import { attentionItemIssueIds } from "./decision-queues.js";
import type { StatusCardDeltaChange, StatusCardFingerprint } from "./status-card-update-engine.js";

/**
 * MIR-376 privacy rules for status cards. Update tasks, stored fingerprints
 * and summaries are readable company-wide, while the owner block is read with
 * the owner's rights, so anything not visible to every member stays out.
 */

/** Desk item kinds whose title and anchor are known to be safe to show (MIR-396). */
const LISTABLE_ATTENTION_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set([
  "issue_thread_interaction",
  "approval",
  "blocker_attention",
  "review",
]);

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Stands in for an issue's id, identifier and title once it is private. */
export const PRIVATE_ISSUE_PLACEHOLDER = "private issue";

/**
 * Of `issueIds`, the issues of this company that pass `condition` (all of
 * them when `condition` is null).
 *
 * @example
 * await readableIssueIds(db, companyId, ids, viewerCondition); // Set of readable ids
 */
export async function readableIssueIds(
  db: Db,
  companyId: string,
  issueIds: string[],
  condition: SQL<boolean> | null,
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const scope = and(eq(issues.companyId, companyId), inArray(issues.id, issueIds));
  const rows = await db.select({ id: issues.id }).from(issues).where(condition ? and(scope, condition) : scope);
  return new Set(rows.map((row) => row.id));
}

/**
 * Of `issueIds`, those every company member may read (no private issue or
 * private project on their privacy chain).
 *
 * @example
 * await companyVisibleIssueIds(db, companyId, [publicId, privateId]); // Set {publicId}
 */
export async function companyVisibleIssueIds(db: Db, companyId: string, issueIds: string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  return readableIssueIds(db, companyId, issueIds, await issueReadSqlCondition(db, { type: "none" }));
}

/**
 * Of `issueIds`, existing issues of this company that not every member may read.
 *
 * @example
 * await companyHiddenIssueIds(db, companyId, [publicId, privateId, "not-an-issue"]); // Set {privateId}
 */
export async function companyHiddenIssueIds(db: Db, companyId: string, issueIds: string[]): Promise<Set<string>> {
  const [existing, visible] = await Promise.all([
    readableIssueIds(db, companyId, issueIds, null),
    companyVisibleIssueIds(db, companyId, issueIds),
  ]);
  return new Set([...existing].filter((issueId) => !visible.has(issueId)));
}

/**
 * Every id an Attention item mentions anywhere (anchors, subject, link,
 * metadata, detail), so a private issue cannot hide in a field the anchor
 * rules do not know about.
 *
 * @example
 * referencedIssueIds(recoveryItem); // includes metadata.recoveryIssueId
 */
export function referencedIssueIds(item: AttentionItem): string[] {
  const mentioned = JSON.stringify(item).match(UUID_PATTERN) ?? [];
  return [...new Set([...attentionItemIssueIds(item), ...mentioned.map((id) => id.toLowerCase())])];
}

function isListableCandidate(item: AttentionItem, watchedIssueIds: ReadonlySet<string>): boolean {
  if (!LISTABLE_ATTENTION_SOURCE_KINDS.has(item.sourceKind)) return false;
  return attentionItemIssueIds(item).some((anchor) => watchedIssueIds.has(anchor));
}

/**
 * Ids of the items a card may list: a known-safe kind, sitting on a watched
 * issue, and mentioning no issue that some company member cannot read.
 *
 * @example
 * await listableAttentionItemIds(db, companyId, items, new Set(watchedIds));
 */
export async function listableAttentionItemIds(
  db: Db,
  companyId: string,
  items: AttentionItem[],
  watchedIssueIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const candidates = items.filter((item) => isListableCandidate(item, watchedIssueIds));
  const mentions = new Map(candidates.map((item) => [item.id, referencedIssueIds(item)]));
  const hidden = await companyHiddenIssueIds(db, companyId, [...new Set([...mentions.values()].flat())]);
  return new Set(candidates
    .filter((item) => !mentions.get(item.id)!.some((issueId) => hidden.has(issueId)))
    .map((item) => item.id));
}

function anonymizeChange(change: StatusCardDeltaChange): StatusCardDeltaChange {
  return {
    issueId: PRIVATE_ISSUE_PLACEHOLDER,
    identifier: PRIVATE_ISSUE_PLACEHOLDER,
    title: "",
    from: null,
    to: null,
    changeKind: change.changeKind,
  };
}

/**
 * Strips the id, title and item ids from changes about issues that left the
 * watched set because they became private, so the next update task does not
 * repeat what the old fingerprint knew about them (MIR-396).
 *
 * @example
 * await anonymizePrivateDepartures(db, companyId, changes, currentFingerprint);
 */
export async function anonymizePrivateDepartures(
  db: Db,
  companyId: string,
  changes: StatusCardDeltaChange[],
  current: StatusCardFingerprint,
): Promise<StatusCardDeltaChange[]> {
  const departed = [...new Set(changes.filter((change) => !current[change.issueId]).map((change) => change.issueId))];
  const hidden = await companyHiddenIssueIds(db, companyId, departed);
  return changes.map((change) => (hidden.has(change.issueId) ? anonymizeChange(change) : change));
}

/**
 * Whether the stored fingerprint holds an issue this viewer cannot read; the
 * summary written from it may then mention that issue (MIR-396).
 *
 * @example
 * await storedFingerprintHidesIssue(db, card, viewerCondition); // true -> redact
 */
export async function storedFingerprintHidesIssue(
  db: Db,
  card: { companyId: string; fingerprint: StatusCardFingerprint | null },
  viewerCondition: SQL<boolean>,
): Promise<boolean> {
  const issueIds = Object.keys(card.fingerprint ?? {});
  if (issueIds.length === 0) return false;
  const [existing, readable] = await Promise.all([
    readableIssueIds(db, card.companyId, issueIds, null),
    readableIssueIds(db, card.companyId, issueIds, viewerCondition),
  ]);
  return readable.size < existing.size;
}

/**
 * Whether the stored fingerprint holds an issue some company member cannot
 * read now; the previous summary may then name it, so it must not be copied
 * into a company-readable update task (MIR-406).
 *
 * @example
 * await storedFingerprintHoldsCompanyHiddenIssue(db, card); // true -> rebuild without previous summary
 */
export async function storedFingerprintHoldsCompanyHiddenIssue(
  db: Db,
  card: { companyId: string; fingerprint: StatusCardFingerprint | null },
): Promise<boolean> {
  const hidden = await companyHiddenIssueIds(db, card.companyId, Object.keys(card.fingerprint ?? {}));
  return hidden.size > 0;
}
