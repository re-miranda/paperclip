import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, issueRecoveryActions, issueRelations, issueThreadInteractions, issues, statusCards } from "@paperclipai/db";
import { attentionService } from "../services/attention.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { readStatusCardBlockerChain, STATUS_CARD_MAX_BLOCKER_ISSUES } from "../services/status-card-owner-attention.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  listedItems,
  OWNER_USER_ID,
  readUpdatePayload,
  statusCardAttentionFixtures,
} from "./helpers/status-card-attention-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("status card owner attention", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const { clearTables, seedCompany, seedIssue, seedPrivateIssue, asSearchSummary, seedBlock, seedHumanOnlyCard, seedCard, ownerItemIdFor, writeSummary, tick, updateRowFor } = statusCardAttentionFixtures(() => db);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-card-attention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await clearTables();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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

  it("rejects a summary that omits a listed Attention item and accepts one that names it", async () => {
    const { company, summarizer, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const blocker = await seedIssue(company.id, `${issuePrefix}-374`, "Terminal on the MacBook", "todo");
    await seedBlock(company.id, blocker.id, watched.id);
    await seedHumanOnlyCard(company.id, blocker.id, "Run the prepared tailscale command", new Date());
    const card = await seedCard(company.id, OWNER_USER_ID);
    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    const generationId = result.generatingIssue!.id;
    expect(listedItems(result.generatingIssue!.description).items.map((item) => item.identifier)).toContain(blocker.identifier);

    await expect(writeSummary(card.id, generationId, summarizer.id, company.id, "Nothing is waiting on you.")).rejects.toThrow(
      new RegExp(`omits listed Attention item\\(s\\): .*${blocker.identifier}`),
    );
    await writeSummary(card.id, generationId, summarizer.id, company.id, `- ${blocker.identifier} waits on you`);
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

    const chain = await readStatusCardBlockerChain(db, company.id, [asSearchSummary(watched)]);

    expect(chain.blockerIssueIds).toHaveLength(STATUS_CARD_MAX_BLOCKER_ISSUES);
    expect(chain.edgesByIssueId.get(watched.id)!.length).toBeLessThanOrEqual(STATUS_CARD_MAX_BLOCKER_ISSUES);
  });

  it("keeps every edge of blockers shared by several card issues within the budget", async () => {
    const { company, issuePrefix } = await seedCompany();
    const first = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire part 1", "blocked");
    const second = await seedIssue(company.id, `${issuePrefix}-318`, "Rosana questionnaire part 2", "blocked");
    const shared = await db.insert(issues).values(Array.from({ length: 150 }, (_, index) => ({
      companyId: company.id, identifier: `${issuePrefix}-${2000 + index}`, title: `Shared dependency ${index}`, status: "todo", priority: "medium",
    }))).returning();
    await db.insert(issueRelations).values([first, second].flatMap((root) => shared.map((blocker) => ({
      companyId: company.id, issueId: blocker.id, relatedIssueId: root.id, type: "blocks",
    }))));

    const chain = await readStatusCardBlockerChain(db, company.id, [asSearchSummary(first), asSearchSummary(second)]);

    expect(chain.blockerIssueIds).toHaveLength(150);
    expect(chain.edgesByIssueId.get(first.id)).toHaveLength(150);
    expect(chain.edgesByIssueId.get(second.id)).toHaveLength(150);
  });

  it("never lists a desk item whose subject is a private blocker, even when it names a public card issue", async () => {
    const { company, summarizer, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const privateBlocker = await seedPrivateIssue(company.id, `${issuePrefix}-374`, "Confidential vendor dispute", "in_review");
    await seedBlock(company.id, privateBlocker.id, watched.id);
    const card = await seedCard(company.id, OWNER_USER_ID);
    const feed = await attentionService(db).list(company.id, { userId: OWNER_USER_ID, all: true, allowUnscopedAll: true });
    // Precondition: the owner's desk really holds a two-anchor item, private subject and public related issue.
    expect(feed.items.some((item) => item.subject.id === privateBlocker.id && item.relatedIssue?.id === watched.id)).toBe(true);

    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });

    const description = result.generatingIssue!.description!;
    for (const secret of ["Confidential vendor dispute", privateBlocker.id, privateBlocker.identifier!]) {
      expect(description).not.toContain(secret);
    }
    expect(listedItems(description).items).toEqual([]);
    await writeSummary(card.id, result.generatingIssue!.id, summarizer.id, company.id);
    const stored = await db.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0]!);
    expect(JSON.stringify(stored.fingerprint)).not.toContain(privateBlocker.id);
  });

  it("never lists a recovery item, so its link to a private recovery issue stays out of the task", async () => {
    const { company, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const privateRecovery = await seedPrivateIssue(company.id, `${issuePrefix}-380`, "Confidential recovery notes");
    await db.insert(issueRecoveryActions).values({
      companyId: company.id, sourceIssueId: watched.id, recoveryIssueId: privateRecovery.id, kind: "manual_review",
      status: "active", ownerType: "user", ownerUserId: OWNER_USER_ID, cause: "stalled", fingerprint: "f1", nextAction: "Check the vendor reply",
    });
    const card = await seedCard(company.id, OWNER_USER_ID);
    const feed = await attentionService(db).list(company.id, { userId: OWNER_USER_ID, all: true, allowUnscopedAll: true });
    // Precondition: the desk's recovery item names the public source but links to the private recovery issue.
    expect(feed.items.some((item) => item.sourceKind === "recovery_action" && item.relatedIssue?.id === watched.id)).toBe(true);

    const result = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });

    const description = result.generatingIssue!.description!;
    for (const secret of ["Confidential recovery notes", privateRecovery.id, privateRecovery.identifier!]) {
      expect(description).not.toContain(secret);
    }
    expect(listedItems(description).items.some((item) => item.issueId === watched.id && item.itemId.startsWith("recovery"))).toBe(false);
  });

  it("redacts the card and anonymizes the change once a watched blocker turns private", async () => {
    const { company, summarizer, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const blocker = await seedIssue(company.id, `${issuePrefix}-374`, "Vendor contract renewal", "todo");
    await seedBlock(company.id, blocker.id, watched.id);
    const card = await seedCard(company.id, OWNER_USER_ID);
    const first = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    await writeSummary(card.id, first.generatingIssue!.id, summarizer.id, company.id);
    await db.update(issues).set({
      visibility: "private", privacyRootIssueId: blocker.id, responsibleUserId: OWNER_USER_ID, updatedAt: new Date(),
    }).where(eq(issues.id, blocker.id));
    const viewer = await issueReadSqlCondition(db, { type: "board", userId: "unrelated-viewer", source: "session" });

    const stored = await db.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0]!);
    const hydrated = await statusCardService(db).hydrate(stored, { issueReadCondition: viewer });
    expect(hydrated).toMatchObject({ privacyRedacted: true, summaryBody: null, fingerprint: null });

    const next = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    for (const secret of ["Vendor contract renewal", blocker.id, blocker.identifier!]) {
      expect(next.generatingIssue!.description!).not.toContain(secret);
    }
    // With every trigger off only the resolved desk item on the blocker survives the filter; it must be anonymous too.
    expect(next.changes!.some((change) => change.issueId === blocker.id)).toBe(false);
    expect(next.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: "private issue", identifier: "private issue", title: "", from: null, to: null }),
    ]));
  });
});
