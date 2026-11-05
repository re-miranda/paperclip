import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companyMemberships, createDb, documents, instanceSettings, issues, statusCards } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { statusCardRoutes } from "../routes/status-cards.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { OWNER_USER_ID, readUpdatePayload, statusCardAttentionFixtures } from "./helpers/status-card-attention-fixtures.js";

/**
 * MIR-406: a watched upstream blocker that was public when the summary was
 * written and is private now must not reach company-readable outputs through
 * that stored summary.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const BLOCKER_TITLE = "Vendor contract renewal";
const UNRELATED_MEMBER_ID = "unrelated-member";

function unrelatedMemberActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: UNRELATED_MEMBER_ID,
    source: "session",
    sessionId: "session-unrelated",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
  };
}

function instanceAdminActor(): Express.Request["actor"] {
  return { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
}

function createStatusCardApp(db: Db, actor: Express.Request["actor"]): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", statusCardRoutes(db, { heartbeat: { wakeup: async () => ({ queued: true }) } }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("status card summary after a watched blocker turns private", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const { clearTables, seedCompany, seedIssue, seedBlock, seedCard, writeSummary } = statusCardAttentionFixtures(() => db);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-card-privacy-transition-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
    await db.delete(companyMemberships);
    await clearTables();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A card whose stored summary names a public, nonmatching blocker, which then turns private. */
  async function seedSummaryNamingPrivatizedBlocker() {
    const { company, summarizer, issuePrefix } = await seedCompany();
    const watched = await seedIssue(company.id, `${issuePrefix}-317`, "Rosana questionnaire: validate answers", "blocked");
    const blocker = await seedIssue(company.id, `${issuePrefix}-374`, BLOCKER_TITLE, "todo");
    await seedBlock(company.id, blocker.id, watched.id);
    const card = await seedCard(company.id, OWNER_USER_ID);
    const first = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    await writeSummary(card.id, first.generatingIssue!.id, summarizer.id, company.id, `Waiting on ${BLOCKER_TITLE} (${blocker.identifier}).`);
    await db.update(issues).set({
      visibility: "private", privacyRootIssueId: blocker.id, responsibleUserId: OWNER_USER_ID, updatedAt: new Date(),
    }).where(eq(issues.id, blocker.id));
    return { company, card };
  }

  async function storedSummaryBody(cardId: string): Promise<string | null> {
    const card = await db.select().from(statusCards).where(eq(statusCards.id, cardId)).then((rows) => rows[0]!);
    const document = await db.select().from(documents).where(eq(documents.id, card.documentId!)).then((rows) => rows[0]!);
    return document.latestBody;
  }

  async function seedUnrelatedMember(companyId: string): Promise<void> {
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: UNRELATED_MEMBER_ID, membershipRole: "operator", status: "active",
    });
  }

  it("rebuilds from scratch without copying the previous summary into the update task", async () => {
    const { card } = await seedSummaryNamingPrivatizedBlocker();
    // Precondition: the stored summary really names the now-private blocker.
    expect(await storedSummaryBody(card.id)).toContain(BLOCKER_TITLE);

    const next = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });

    const description = next.generatingIssue!.description!;
    expect(description).not.toContain(BLOCKER_TITLE);
    expect(readUpdatePayload(description).kind).toBe("full");
  });

  it("keeps summary history and update summaries from an unrelated member, as the card does", async () => {
    const { company, card } = await seedSummaryNamingPrivatizedBlocker();
    await seedUnrelatedMember(company.id);
    const member = createStatusCardApp(db, unrelatedMemberActor(company.id));

    const detail = await request(member).get(`/api/status-cards/${card.id}`);
    const history = await request(member).get(`/api/status-cards/${card.id}/summary-revisions`);
    const updates = await request(member).get(`/api/status-cards/${card.id}/updates`);

    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ privacyRedacted: true, summaryBody: null });
    expect(history.status).toBe(200);
    expect(history.body).toEqual([]);
    expect(updates.status).toBe(200);
    expect(updates.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(updates.body)).not.toContain(BLOCKER_TITLE);
  });

  it("still shows summary history to a viewer who can read the blocker", async () => {
    const { company, card } = await seedSummaryNamingPrivatizedBlocker();
    await seedUnrelatedMember(company.id);
    const admin = createStatusCardApp(db, instanceAdminActor());

    const history = await request(admin).get(`/api/status-cards/${card.id}/summary-revisions`);
    const updates = await request(admin).get(`/api/status-cards/${card.id}/updates`);

    expect(history.status).toBe(200);
    expect(history.body.map((revision: { body: string }) => revision.body)).toEqual(expect.arrayContaining([expect.stringContaining(`Waiting on ${BLOCKER_TITLE}`)]));
    expect(JSON.stringify(updates.body)).toContain(BLOCKER_TITLE);
  });
});
