import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
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
  issueRelations,
  issueThreadInteractions,
  issues,
  statusCards,
  statusCardUpdates,
} from "@paperclipai/db";
import { companySearchQuerySchema, statusCardRefreshPolicySchema } from "@paperclipai/shared";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { attentionService } from "../services/attention.js";
import { readStatusCardBlockerChain, STATUS_CARD_MAX_BLOCKER_ISSUES } from "../services/status-card-owner-attention.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type OwnerAttentionPayload =
  | { owner: "none" }
  | { owner: "user"; items: Array<{ itemId: string; issueId: string; identifier: string | null }>; elsewhereCount: number };

const OWNER_USER_ID = "owner-user";
// Every trigger off: only owner Attention changes may wake the card.
const TRIGGERS_OFF_POLICY = statusCardRefreshPolicySchema.parse({
  mode: "interval",
  intervalMinutes: 15,
  triggers: { anyUpdate: false, membershipChanges: false, assigneeChanges: false, humanComments: false, statusTransitions: false },
});

function readUpdatePayload(description: string | null) {
  const match = description?.match(/```json\n([\s\S]*?)\n```/);
  return JSON.parse(match![1]!) as { kind: string; ownerAttention: OwnerAttentionPayload };
}

function listedItems(description: string | null) {
  const attention = readUpdatePayload(description).ownerAttention;
  if (attention.owner !== "user") throw new Error(`expected an owned card, got ${JSON.stringify(attention)}`);
  return attention;
}

describeEmbeddedPostgres("status card owner attention", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-card-attention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Reading the Attention desk materializes decision queues, so clear them too.
    await db.delete(inboxDismissals);
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(decisionRetention);
    await db.delete(decisionTriageEvents);
    await db.delete(decisionTriage);
    await db.delete(decisionQueueItems);
    await db.delete(decisionQueues);
    await db.delete(decisions);
    await db.delete(statusCardUpdates);
    await db.delete(statusCards);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const issuePrefix = `MR${randomUUID().replace(/[^A-F]/gi, "").slice(0, 4).toUpperCase()}`;
    const company = await db.insert(companies).values({ name: "Owner Attention Co", issuePrefix }).returning().then((rows) => rows[0]!);
    const summarizer = await db.insert(agents).values({
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
    return db.insert(issues).values({ companyId, identifier, title, status, priority: "medium" }).returning().then((rows) => rows[0]!);
  }

  async function seedPrivateIssue(companyId: string, identifier: string, title: string) {
    const id = randomUUID();
    return db.insert(issues).values({
      id, companyId, identifier, title, status: "todo", priority: "medium",
      visibility: "private", privacyRootIssueId: id, responsibleUserId: OWNER_USER_ID,
    }).returning().then((rows) => rows[0]!);
  }

  async function seedBlock(companyId: string, blockerId: string, blockedId: string) {
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: blockedId, type: "blocks" });
  }

  async function seedHumanOnlyCard(companyId: string, issueId: string, title: string, at: Date) {
    return db.insert(issueThreadInteractions).values({
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
    return db.insert(statusCards).values({
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
    const feed = await attentionService(db).list(companyId, { userId: OWNER_USER_ID, all: true, allowUnscopedAll: true });
    return feed.items.find((item) => item.subject.id === interactionId)!.id;
  }

  async function writeSummary(cardId: string, generationIssueId: string, summarizerId: string, companyId: string) {
    const run = await db.insert(heartbeatRuns).values({ companyId, agentId: summarizerId, status: "running" }).returning().then((rows) => rows[0]!);
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, generationIssueId));
    await statusCardService(db).writeSummary(cardId, {
      generationIssueId,
      markdown: "Summary.",
      changeSummary: "Summary.",
      model: "gpt-5.4",
    }, { agentId: summarizerId, runId: run.id });
    // The Summarizer closes its task after writing, as in production.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, generationIssueId));
  }

  async function tick(cardId: string) {
    await db.update(statusCards).set({ nextEvalAt: new Date(Date.now() - 1000) }).where(eq(statusCards.id, cardId));
    return statusCardService(db).tickDueStatusCards(new Date());
  }

  // A fingerprint seen before reuses its generation task, so take the newest ledger row.
  async function updateRowFor(generationIssueId: string) {
    return db.select().from(statusCardUpdates)
      .where(eq(statusCardUpdates.generationIssueId, generationIssueId))
      .orderBy(desc(statusCardUpdates.startedAt))
      .then((rows) => rows[0]!);
  }

  it("4 Nov regression, full update: lists the blocker's pending card first and counts unrelated items elsewhere", async () => {
    const { company, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const blocker = await seedIssue(company.id, `${issuePrefix}-374`, "Terminal on the MacBook", "todo");
    const unrelated = await seedIssue(company.id, `${issuePrefix}-900`, "Pick a logo", "todo");
    await seedBlock(company.id, blocker.id, watched.id);
    const blockerCard = await seedHumanOnlyCard(company.id, blocker.id, "Run the prepared tailscale command", new Date("2026-11-04T18:41:00Z"));
    const unrelatedCard = await seedHumanOnlyCard(company.id, unrelated.id, "Choose a logo", new Date("2026-11-04T19:00:00Z"));
    const card = await seedCard(company.id, OWNER_USER_ID);

    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });

    const description = result.generatingIssue!.description;
    expect(readUpdatePayload(description).kind).toBe("full");
    const attention = listedItems(description);
    expect(attention.items[0]).toMatchObject({ issueId: blocker.id, identifier: blocker.identifier });
    expect(attention.items.map((item) => item.itemId)).toContain(await ownerItemIdFor(company.id, blockerCard.id));
    expect(attention.items.map((item) => item.itemId)).not.toContain(await ownerItemIdFor(company.id, unrelatedCard.id));
    expect(attention.items.some((item) => item.issueId === unrelated.id)).toBe(false);
    expect(attention.elsewhereCount).toBeGreaterThanOrEqual(1);
    expect(description).toContain("## Waiting on the card owner");
    expect(description).toContain("Run the prepared tailscale command");
    expect(description).toContain(`linking to /${issuePrefix}/decisions`);
    // The blocker joined the watched set, so the summarizer also sees its state.
    expect(description).toContain(`"identifier": "${blocker.identifier}"`);
    const refreshed = await db.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0]!);
    expect(refreshed.pendingChangeCount).toBeGreaterThan(0);
  });

  it("4 Nov regression, incremental update: a new card on an upstream blocker marks the card changed and is listed first", async () => {
    const { company, summarizer, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const middle = await seedIssue(company.id, `${issuePrefix}-386`, "MacBook study", "blocked");
    const blocker = await seedIssue(company.id, `${issuePrefix}-374`, "Terminal on the MacBook", "todo");
    await seedBlock(company.id, middle.id, watched.id);
    await seedBlock(company.id, blocker.id, middle.id);
    const card = await seedCard(company.id, OWNER_USER_ID);

    const first = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    await writeSummary(card.id, first.generatingIssue!.id, summarizer.id, company.id);
    const stored = await db.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0]!);
    expect(Object.keys(stored.fingerprint ?? {}).sort()).toEqual([watched.id, middle.id, blocker.id].sort());
    expect(await tick(card.id)).toMatchObject({ evaluated: 1, enqueued: [] });

    const pending = await seedHumanOnlyCard(company.id, blocker.id, "Run the prepared tailscale command", new Date());
    const itemId = await ownerItemIdFor(company.id, pending.id);
    const changed = await tick(card.id);

    expect(changed.enqueued).toHaveLength(1);
    const generationIssue = changed.enqueued[0]!.generatingIssue;
    expect(readUpdatePayload(generationIssue.description).kind).toBe("incremental");
    expect(listedItems(generationIssue.description).items[0]).toMatchObject({ issueId: blocker.id });
    expect(listedItems(generationIssue.description).items.map((item) => item.itemId)).toContain(itemId);
    // The desk may also retire its own "stalled blocker" row now that a card
    // covers the blocker; that is a real desk change too, so only require ours.
    expect((await updateRowFor(generationIssue.id)).changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: blocker.id, changeKind: "attention", from: null, to: itemId }),
    ]));

    await writeSummary(card.id, generationIssue.id, summarizer.id, company.id);
    expect(await tick(card.id)).toMatchObject({ evaluated: 1, enqueued: [] });

    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, pending.id));
    const resolved = await tick(card.id);
    expect(resolved.enqueued).toHaveLength(1);
    expect((await updateRowFor(resolved.enqueued[0]!.generatingIssue.id)).changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: blocker.id, changeKind: "attention", from: itemId, to: null }),
    ]));
  });

  it("orders items by how much of the card's work they hold up, not by desk recency", async () => {
    const { company, issuePrefix } = await seedCompany();
    const b1 = await seedIssue(company.id, `${issuePrefix}-301`, "Rosana questionnaire part 1", "blocked");
    const b2 = await seedIssue(company.id, `${issuePrefix}-302`, "Rosana questionnaire part 2", "blocked");
    const b3 = await seedIssue(company.id, `${issuePrefix}-303`, "Rosana questionnaire part 3", "blocked");
    const wide = await seedIssue(company.id, `${issuePrefix}-310`, "Shared dependency", "todo");
    const narrow = await seedIssue(company.id, `${issuePrefix}-311`, "Single dependency", "todo");
    await seedBlock(company.id, wide.id, b1.id);
    await seedBlock(company.id, wide.id, b2.id);
    await seedBlock(company.id, narrow.id, b3.id);
    const older = await seedHumanOnlyCard(company.id, wide.id, "Older card, holds up two", new Date("2026-11-04T10:00:00Z"));
    const newer = await seedHumanOnlyCard(company.id, narrow.id, "Newer card, holds up one", new Date("2026-11-04T20:00:00Z"));
    const card = await seedCard(company.id, OWNER_USER_ID);
    const olderId = await ownerItemIdFor(company.id, older.id);
    const newerId = await ownerItemIdFor(company.id, newer.id);

    const feed = await attentionService(db).list(company.id, { userId: OWNER_USER_ID, all: true, allowUnscopedAll: true });
    const deskOrder = feed.items.map((item) => item.id);
    expect(deskOrder.indexOf(newerId)).toBeLessThan(deskOrder.indexOf(olderId));

    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    const cardOrder = listedItems(result.generatingIssue!.description).items.map((item) => item.itemId);
    expect(cardOrder.indexOf(olderId)).toBeGreaterThanOrEqual(0);
    expect(cardOrder.indexOf(olderId)).toBeLessThan(cardOrder.indexOf(newerId));
  });

  it("skips the block for an agent-created card and says so", async () => {
    const { company } = await seedCompany();
    const watched = await seedIssue(company.id, "AGT-1", "Rosana questionnaire", "blocked");
    await seedHumanOnlyCard(company.id, watched.id, "Waiting on someone", new Date());
    const card = await seedCard(company.id, null);

    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });

    expect(readUpdatePayload(result.generatingIssue!.description).ownerAttention).toEqual({ owner: "none" });
    expect(result.generatingIssue!.description).toContain("has no owner");
  });

  it("keeps private blockers and their cards out of the company-readable task and snapshot", async () => {
    const { company, summarizer, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const privateBlocker = await seedPrivateIssue(company.id, `${issuePrefix}-374`, "Confidential vendor dispute");
    const behindPrivate = await seedIssue(company.id, `${issuePrefix}-375`, "Public step behind the private one", "todo");
    await seedBlock(company.id, privateBlocker.id, watched.id);
    await seedBlock(company.id, behindPrivate.id, privateBlocker.id);
    await seedHumanOnlyCard(company.id, privateBlocker.id, "Secret question for the owner", new Date());
    const card = await seedCard(company.id, OWNER_USER_ID);

    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });

    const description = result.generatingIssue!.description!;
    for (const secret of ["Confidential vendor dispute", "Secret question for the owner", privateBlocker.id, privateBlocker.identifier!]) {
      expect(description).not.toContain(secret);
    }
    expect(description).not.toContain(behindPrivate.identifier!);
    const attention = listedItems(description);
    expect(attention.items).toEqual([]);
    expect(attention.elsewhereCount).toBeGreaterThanOrEqual(1);
    await writeSummary(card.id, result.generatingIssue!.id, summarizer.id, company.id);
    const stored = await db.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0]!);
    expect(Object.keys(stored.fingerprint ?? {})).toEqual([watched.id]);
  });

  it("bounds the blocker walk itself, not only the watched list", async () => {
    const { company, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const blockerCount = STATUS_CARD_MAX_BLOCKER_ISSUES + 50;
    const blockers = await db.insert(issues).values(Array.from({ length: blockerCount }, (_, index) => ({
      companyId: company.id, identifier: `${issuePrefix}-${1000 + index}`, title: `Dependency ${index}`, status: "todo", priority: "medium",
    }))).returning();
    await db.insert(issueRelations).values(blockers.map((blocker) => ({
      companyId: company.id, issueId: blocker.id, relatedIssueId: watched.id, type: "blocks",
    })));
    const root = { ...watched, status: "blocked" as const, priority: "medium" as const, updatedAt: watched.updatedAt.toISOString() };

    const chain = await readStatusCardBlockerChain(db, company.id, [root]);

    expect(chain.blockerIssueIds).toHaveLength(STATUS_CARD_MAX_BLOCKER_ISSUES);
    expect(chain.edgesByIssueId.get(watched.id)!.length).toBeLessThanOrEqual(STATUS_CARD_MAX_BLOCKER_ISSUES);
  });
});
