import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

// Tool output the agent itself printed. It carries the literal phrase the
// model-not-found detector scans for, but the provider never returned it.
const POISONED_TOOL_OUTPUT =
  'execute.ts:1199: : failed && isClaudeModelNotFoundError({ ... ? "model_not_found"';

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = "") {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(extraStdout
        ? [
            JSON.stringify({
              type: "assistant",
              session_id: "claude-session-1",
              message: { content: [{ type: "text", text: extraStdout }] },
            }),
          ]
        : []),
      JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

function buildContext() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local failure classification precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps max_turns_exhausted when stdout mentions model_not_found", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_max_turns" }, POISONED_TOOL_OUTPUT),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("still reports model_not_found when the provider returns it", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 404 model not found" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("model_not_found");
  });

  // MIR-1176: a usage-limit stop must not become a sign-in failure because a
  // tool printed "Unauthorized" earlier in the run.
  describe("usage-limit stops (MIR-1176)", () => {
    const USAGE_LIMIT_STOP_TEXT = "You've hit your 5-hour limit · resets 2:40am (UTC)";
    const UNAUTHORIZED_TOOL_OUTPUT = "curl: (22) The requested URL returned error: 401 Unauthorized";
    const limitResult = { is_error: true, subtype: "success", result: USAGE_LIMIT_STOP_TEXT };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-16T22:05:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("labels the 16 Nov message provider_quota with the next 02:40 UTC reset", async () => {
      mockExecutionResult(buildProcResult(limitResult));

      const result = await execute(buildContext() as never);

      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
      expect(result.retryNotBefore).toBe("2026-11-17T02:40:00.000Z");
    });

    it("stays provider_quota when tool output contains Unauthorized", async () => {
      mockExecutionResult(buildProcResult(limitResult, UNAUTHORIZED_TOOL_OUTPUT));

      const result = await execute(buildContext() as never);

      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
      expect(result.retryNotBefore).toBe("2026-11-17T02:40:00.000Z");
    });

    it("stays provider_quota on the unparsed fallback path", async () => {
      const withResult = buildProcResult(limitResult, UNAUTHORIZED_TOOL_OUTPUT);
      const stdoutWithoutResult = withResult.stdout.split("\n").slice(0, -1).join("\n");
      mockExecutionResult({ ...withResult, stdout: stdoutWithoutResult, stderr: USAGE_LIMIT_STOP_TEXT });

      const result = await execute(buildContext() as never);

      expect(result.errorCode).toBe("provider_quota");
      expect(result.retryNotBefore).toBe("2026-11-17T02:40:00.000Z");
    });

    it("takes the fallback reset time from stderr, not from quoted tool output (MIR-1189)", async () => {
      const quotedReset = `Example: You've hit your 5-hour limit · resets 9am (UTC). ${UNAUTHORIZED_TOOL_OUTPUT}`;
      const withResult = buildProcResult(limitResult, quotedReset);
      const stdoutWithoutResult = withResult.stdout.split("\n").slice(0, -1).join("\n");
      mockExecutionResult({
        ...withResult,
        stdout: stdoutWithoutResult,
        stderr: `Warning: diagnostic line\n${USAGE_LIMIT_STOP_TEXT}`,
      });

      const result = await execute(buildContext() as never);

      expect(result.errorCode).toBe("provider_quota");
      expect(result.retryNotBefore).toBe("2026-11-17T02:40:00.000Z");
    });

    it("still reports claude_auth_required for a real sign-in failure", async () => {
      mockExecutionResult(
        buildProcResult({
          is_error: true,
          subtype: "success",
          result: "Failed to authenticate. API Error: 401 Invalid bearer token",
        }),
      );
      const tokenFailure = await execute(buildContext() as never);
      expect(tokenFailure.errorCode).toBe("claude_auth_required");

      const loginPrompt = buildProcResult({ is_error: true, subtype: "success", result: "Please run /login" });
      mockExecutionResult({ ...loginPrompt, stderr: USAGE_LIMIT_STOP_TEXT });
      const promptFailure = await execute(buildContext() as never);
      expect(promptFailure.errorCode).toBe("claude_auth_required");
    });

    it("changes nothing for a successful run whose tool output quotes the limit text", async () => {
      const success = buildProcResult(
        { is_error: false, subtype: "success", result: "Done." },
        USAGE_LIMIT_STOP_TEXT,
      );
      mockExecutionResult({ ...success, exitCode: 0 });

      const result = await execute(buildContext() as never);

      expect(result.errorCode).toBeNull();
      expect(result.errorFamily).toBeNull();
      expect(result.retryNotBefore).toBeNull();
    });
  });
});
