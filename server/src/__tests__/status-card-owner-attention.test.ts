import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionSubject } from "@paperclipai/shared";
import { attentionItemIssueIds } from "../services/decision-queues.js";
import {
  attachOwnerAttention,
  memoizeOwnerAttentionLoader,
  rankStatusCardOwnerAttention,
  upstreamIssueIds,
  type StatusCardOwnerAttention,
} from "../services/status-card-owner-attention.js";
import { ownerAttentionPayload, ownerAttentionPromptSection } from "../services/status-card-owner-attention-prompt.js";

function issueSubjectFixture(id: string): AttentionSubject {
  return { kind: "issue", id, companyId: "co", title: id, identifier: id, status: "todo", href: `/MIR/issues/${id}` };
}

/** An Attention item pending on the owner, anchored on `issueId` the way interaction cards are. */
function interactionItemFixture(id: string, issueId: string, rank: number): AttentionItem {
  return {
    id,
    rank,
    sourceKind: "issue_thread_interaction",
    subject: { kind: "interaction", id, companyId: "co", title: `Card ${id}`, identifier: null, status: "pending", href: null, metadata: { issueId } },
    relatedIssue: issueSubjectFixture(issueId),
  } as AttentionItem;
}

/** Records how often the Attention desk was read. */
class CountingAttentionLoader {
  calls = 0;
  load = async (_companyId: string, _userId: string): Promise<AttentionItem[]> => {
    this.calls += 1;
    return [];
  };
}

/** Stands in for the untrusted-data quoting of status-cards.ts. */
function quote(label: string, value: unknown): string {
  return `<${label}>${JSON.stringify(value)}</${label}>`;
}

const watched = (id: string, status = "blocked") => ({ id, identifier: id, status: status as "blocked" });

describe("status card owner attention", () => {
  it("walks every hop upstream and survives cycles", () => {
    const edges = new Map([["b", ["a"]], ["a", ["z", "b"]]]);
    expect([...upstreamIssueIds("b", edges)].sort()).toEqual(["a", "b", "z"]);
  });

  it("anchors a blocker item on its blocker first, then the issue it blocks", () => {
    const item = { subject: issueSubjectFixture("A"), relatedIssue: issueSubjectFixture("B") } as AttentionItem;
    expect(attentionItemIssueIds(item)).toEqual(["A", "B"]);
  });

  it("lists items on the card's blocker chain, counts the rest elsewhere", () => {
    const ranked = rankStatusCardOwnerAttention({
      items: [interactionItemFixture("unrelated", "U", 1), interactionItemFixture("on-blocker", "A", 2)],
      cardIssues: [watched("B")],
      watchedIssues: new Map([["B", watched("B")], ["A", watched("A", "todo")]]),
      edgesByIssueId: new Map([["B", ["A"]]]),
    });

    expect(ranked.items.map((item) => [item.itemId, item.identifier, item.heldUpIdentifiers])).toEqual([
      ["on-blocker", "A", ["B"]],
    ]);
    expect(ranked.elsewhereCount).toBe(1);
  });

  it("ranks by work held up, then by the Attention desk's order", () => {
    const ranked = rankStatusCardOwnerAttention({
      items: [
        interactionItemFixture("small-first-on-desk", "C", 1),
        interactionItemFixture("big", "A", 3),
        interactionItemFixture("small-later-on-desk", "C", 2),
      ],
      cardIssues: [watched("B1"), watched("B2"), watched("B3"), watched("Closed", "done")],
      watchedIssues: new Map(["A", "C", "B1", "B2", "B3", "Closed"].map((id) => [id, watched(id)])),
      edgesByIssueId: new Map([["B1", ["A"]], ["B2", ["A"]], ["B3", ["C"]], ["Closed", ["C"]]]),
    });

    expect(ranked.items.map((item) => [item.itemId, item.holdsUpCount])).toEqual([
      ["big", 2],
      ["small-first-on-desk", 1],
      ["small-later-on-desk", 1],
    ]);
  });

  it("stores listed item ids on the issue they sit on", () => {
    const attention: StatusCardOwnerAttention = {
      owner: "user", userId: "u", elsewhereCount: 0, attentionHref: "/MIR/decisions",
      items: [{ itemId: "x", title: null, sourceKind: "approval", href: null, issueId: "A", identifier: "A", holdsUpCount: 1, heldUpIdentifiers: ["B"] }],
    };
    const fingerprint = { A: { status: "todo", updatedAt: "t" }, B: { status: "blocked", updatedAt: "t" } };

    expect(attachOwnerAttention(fingerprint, attention)).toEqual({
      A: { status: "todo", updatedAt: "t", attentionItemIds: ["x"] },
      B: { status: "blocked", updatedAt: "t" },
    });
    expect(attachOwnerAttention(fingerprint, { owner: "none" })).toBe(fingerprint);
  });

  it("reads each owner's desk once per scheduler tick", async () => {
    const counting = new CountingAttentionLoader();
    const load = memoizeOwnerAttentionLoader(counting.load);
    await Promise.all([load("co", "u1"), load("co", "u1"), load("co", "u2")]);
    expect(counting.calls).toBe(2);
  });

  it("tells the summarizer when a card has no owner", () => {
    expect(ownerAttentionPromptSection({ owner: "none" }, quote)).toContain("has no owner");
    expect(ownerAttentionPayload({ owner: "none" })).toEqual({ owner: "none" });
  });

  it("puts item titles in the untrusted block and the elsewhere link in the instructions", () => {
    const attention: StatusCardOwnerAttention = {
      owner: "user", userId: "u", elsewhereCount: 2, attentionHref: "/MIR/decisions",
      items: [{ itemId: "x", title: "Run the prepared tailscale command", sourceKind: "issue_thread_interaction", href: null, issueId: "A", identifier: "MIR-374", holdsUpCount: 1, heldUpIdentifiers: ["MIR-317"] }],
    };
    const section = ownerAttentionPromptSection(attention, quote);

    expect(section).toContain("<owner-attention>[{\"title\":\"Run the prepared tailscale command\"");
    expect(section).toContain("2 other item(s) wait on the owner elsewhere, linking to /MIR/decisions");
    expect(ownerAttentionPayload(attention)).toEqual({
      owner: "user", items: [{ itemId: "x", issueId: "A", identifier: "MIR-374" }], elsewhereCount: 2,
    });
  });
});
