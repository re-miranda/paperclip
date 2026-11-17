import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  type createDb,
  decisionArchiveNotificationOutbox,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisions,
  decisionTriage,
  decisionTriageEvents,
  documentRevisions,
  documents,
  heartbeatRuns,
  inboxDismissals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  statusCards,
  statusCardUpdates,
} from "@paperclipai/db";
import { companySearchQuerySchema, statusCardRefreshPolicySchema, type CompanySearchIssueSummary } from "@paperclipai/shared";
import { withBuiltInAgentMarker } from "../../lib/built-in-agent-metadata.js";
import { attentionService } from "../../services/attention.js";
import { statusCardService } from "../../services/status-cards.js";

/**
 * Embedded-Postgres fixtures shared by the MIR-376 status-card owner-attention
 * suites. `getDb` is read lazily because each suite opens its database in `beforeAll`.
 */

type Db = ReturnType<typeof createDb>;

export type OwnerAttentionPayload =
  | { owner: "none" }
  | { owner: "user"; items: Array<{ itemId: string; issueId: string; identifier: string | null }>; elsewhereCount: number };

export const OWNER_USER_ID = "owner-user";
// Every trigger off: only owner Attention changes may wake the card.
export const TRIGGERS_OFF_POLICY = statusCardRefreshPolicySchema.parse({
  mode: "interval",
  intervalMinutes: 15,
  triggers: { anyUpdate: false, membershipChanges: false, assigneeChanges: false, humanComments: false, statusTransitions: false },
});

export function readUpdatePayload(description: string | null) {
  const match = description?.match(/```json\n([\s\S]*?)\n```/);
  return JSON.parse(match![1]!) as { kind: string; ownerAttention: OwnerAttentionPayload };
}

export function listedItems(description: string | null) {
  const attention = readUpdatePayload(description).ownerAttention;
  if (attention.owner !== "user") throw new Error(`expected an owned card, got ${JSON.stringify(attention)}`);
  return attention;
}


/**
 * Seed and drive helpers bound to a suite's database.
 *
 * @example
 * const { seedCompany, seedCard } = statusCardAttentionFixtures(() => db);
 */
export function statusCardAttentionFixtures(getDb: () => Db) {
  async function clearTables() {
    // Reading the Attention desk materializes decision queues, so clear them too.
    await getDb().delete(inboxDismissals);
    await getDb().delete(decisionArchiveNotificationOutbox);
    await getDb().delete(decisionRetention);
    await getDb().delete(decisionTriageEvents);
    await getDb().delete(decisionTriage);
    await getDb().delete(decisionQueueItems);
    await getDb().delete(decisionQueues);
    await getDb().delete(decisions);
    await getDb().delete(statusCardUpdates);
    await getDb().delete(statusCards);
    await getDb().delete(documentRevisions);
    await getDb().delete(documents);
    await getDb().delete(issueThreadInteractions);
    await getDb().delete(issueRecoveryActions);
    await getDb().delete(issueRelations);
    await getDb().delete(issueComments);
    await getDb().delete(issues);
    await getDb().delete(activityLog);
    await getDb().delete(heartbeatRuns);
    await getDb().delete(agents);
    await getDb().delete(companies);
  }

  async function seedCompany() {
    const issuePrefix = `MR${randomUUID().replace(/[^A-F]/gi, "").slice(0, 4).toUpperCase()}`;
    const company = await getDb().insert(companies).values({ name: "Owner Attention Co", issuePrefix }).returning().then((rows) => rows[0]!);
    const summarizer = await getDb().insert(agents).values({
      companyId: company.id,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    }).returning().then((rows) => rows[0]!);
    return { company, summarizer, issuePrefix };
  }

  async function seedIssue(companyId: string, identifier: string, title: string, status: string) {
    return getDb().insert(issues).values({ companyId, identifier, title, status, priority: "medium" }).returning().then((rows) => rows[0]!);
  }

  async function seedPrivateIssue(companyId: string, identifier: string, title: string, status = "todo") {
    const id = randomUUID();
    return getDb().insert(issues).values({
      id, companyId, identifier, title, status, priority: "medium",
      visibility: "private", privacyRootIssueId: id, responsibleUserId: OWNER_USER_ID,
    }).returning().then((rows) => rows[0]!);
  }

  function asSearchSummary(issue: typeof issues.$inferSelect): CompanySearchIssueSummary {
    return { ...issue, status: issue.status as "blocked", priority: issue.priority as "medium", updatedAt: issue.updatedAt.toISOString() };
  }

  async function seedBlock(companyId: string, blockerId: string, blockedId: string) {
    await getDb().insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: blockedId, type: "blocks" });
  }

  async function seedHumanOnlyCard(companyId: string, issueId: string, title: string, at: Date) {
    return getDb().insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      title,
      payload: { version: 1, questions: [] },
      createdAt: at,
      updatedAt: at,
    }).returning().then((rows) => rows[0]!);
  }

  async function seedCard(companyId: string, createdByUserId: string | null) {
    return getDb().insert(statusCards).values({
      companyId,
      createdByUserId,
      title: "Rosana questionnaire validation queue",
      interestPrompt: "Rosana questionnaire validation queue",
      queries: [companySearchQuerySchema.parse({ q: "Rosana", scope: "issues", limit: 20 })],
      queryVersion: 1,
      refreshPolicy: TRIGGERS_OFF_POLICY,
      state: "active",
    }).returning().then((rows) => rows[0]!);
  }

  async function ownerItemIdFor(companyId: string, interactionId: string) {
    const feed = await attentionService(getDb()).list(companyId, { userId: OWNER_USER_ID, all: true, allowUnscopedAll: true });
    return feed.items.find((item) => item.subject.id === interactionId)!.id;
  }

  /** A summary that opens with every Attention item the task listed, as the write-back guard requires. */
  async function summaryListingTaskItems(generationIssueId: string): Promise<string> {
    const task = await getDb().select().from(issues).where(eq(issues.id, generationIssueId)).then((rows) => rows[0]!);
    const attention = readUpdatePayload(task.description).ownerAttention;
    const identifiers = attention.owner === "user" ? attention.items.map((item) => item.identifier) : [];
    return ["Summary.", ...identifiers.map((identifier) => `- ${identifier} waits on you`)].join("\n");
  }

  async function writeSummary(cardId: string, generationIssueId: string, summarizerId: string, companyId: string, markdown?: string) {
    markdown ??= await summaryListingTaskItems(generationIssueId);
    const run = await getDb().insert(heartbeatRuns).values({ companyId, agentId: summarizerId, status: "running" }).returning().then((rows) => rows[0]!);
    await getDb().update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, generationIssueId));
    await statusCardService(getDb()).writeSummary(cardId, {
      generationIssueId,
      markdown,
      changeSummary: markdown,
      model: "gpt-5.4",
    }, { agentId: summarizerId, runId: run.id });
    // The Summarizer closes its task after writing, as in production.
    await getDb().update(issues).set({ status: "done" }).where(eq(issues.id, generationIssueId));
  }

  async function tick(cardId: string) {
    await getDb().update(statusCards).set({ nextEvalAt: new Date(Date.now() - 1000) }).where(eq(statusCards.id, cardId));
    return statusCardService(getDb()).tickDueStatusCards(new Date());
  }

  // A fingerprint seen before reuses its generation task, so take the newest ledger row.
  async function updateRowFor(generationIssueId: string) {
    return getDb().select().from(statusCardUpdates)
      .where(eq(statusCardUpdates.generationIssueId, generationIssueId))
      .orderBy(desc(statusCardUpdates.startedAt))
      .then((rows) => rows[0]!);
  }

  return { clearTables, seedCompany, seedIssue, seedPrivateIssue, asSearchSummary, seedBlock, seedHumanOnlyCard, seedCard, ownerItemIdFor, writeSummary, tick, updateRowFor };
}
