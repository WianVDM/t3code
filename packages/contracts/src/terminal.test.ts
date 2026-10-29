import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
  TerminalSummary,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).toBe(
      "Could not prepare the terminal environment for provider instance: codex_work",
    );
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("TerminalOpenInput", () => {
  it("drops invalid env keys while retaining valid overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      env: { "bad-key": "1", GOOD_KEY: "2" },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "2" });
  });
});

describe("TerminalSummary", () => {
  const base = {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: "/tmp/project",
    worktreePath: null,
    status: "running",
    pid: 1234,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "Primary",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("decodes summaries from an older server that has no startedAt", () => {
    const summary = decodeSync(TerminalSummary, base);
    expect(summary.startedAt).toBeUndefined();
  });

  it("keeps the session start time when a newer server reports it", () => {
    const summary = decodeSync(TerminalSummary, {
      ...base,
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(summary.startedAt).toBe("2026-01-01T00:00:01.000Z");
  });
});
