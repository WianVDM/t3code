import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { kimiUsageResponseToLimits, readKimiCodeAccount } from "./usageLimits.ts";

const checkedAt = "2026-10-22T12:00:00.000Z";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Kimi Code usage limits mapping", () => {
  it("maps the full real payload to session and weekly windows", () => {
    const payload = {
      usage: {
        limit: "100",
        used: "90",
        remaining: "10",
        resetTime: "2026-10-27T06:09:31.207136Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "8",
            remaining: "92",
            resetTime: "2026-10-22T14:09:31.207136Z",
          },
        },
      ],
      usages: {
        limit_5h: { used_ratio: 0.08, reset_time: "2026-10-22T14:09:30Z" },
        limit_7d: { used_ratio: 0.8989, reset_time: "2026-10-27T06:09:30Z" },
      },
    };

    const limits = kimiUsageResponseToLimits(payload, checkedAt);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.checkedAt).toBe(checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "kimi-5h",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 8,
        resetsAt: "2026-10-22T14:09:30Z",
        windowDurationMins: 300,
      },
      {
        id: "kimi-7d",
        kind: "weekly",
        label: "Kimi Code Weekly",
        usedPercent: 89.89,
        resetsAt: "2026-10-27T06:09:30Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("parses string-formatted numbers tolerantly", () => {
    const payload = {
      usages: {
        limit_5h: { used_ratio: "0.08", reset_time: "2026-10-22T14:09:30Z" },
        limit_7d: { used_ratio: "0.8989", reset_time: "2026-10-27T06:09:30Z" },
      },
    };

    const limits = kimiUsageResponseToLimits(payload, checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "kimi-5h",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 8,
        resetsAt: "2026-10-22T14:09:30Z",
        windowDurationMins: 300,
      },
      {
        id: "kimi-7d",
        kind: "weekly",
        label: "Kimi Code Weekly",
        usedPercent: 89.89,
        resetsAt: "2026-10-27T06:09:30Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("falls back to usage and limits[] when usages key is absent", () => {
    const fallbackPayload = {
      usage: {
        limit: "100",
        used: "90",
        remaining: "10",
        resetTime: "2026-10-27T06:09:31.207136Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "100",
            used: "8",
            remaining: "92",
            resetTime: "2026-10-22T14:09:31.207136Z",
          },
        },
      ],
    };

    const limits = kimiUsageResponseToLimits(fallbackPayload, checkedAt);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "kimi-limit-0",
        kind: "session",
        label: "Kimi Code 5-hour",
        usedPercent: 8,
        resetsAt: "2026-10-22T14:09:31.207136Z",
        windowDurationMins: 300,
      },
      {
        id: "kimi-7d",
        kind: "weekly",
        label: "Kimi Code Weekly",
        usedPercent: 90,
        resetsAt: "2026-10-27T06:09:31.207136Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("treats an unparseable or empty payload as probe failure", () => {
    for (const invalid of [
      {},
      null,
      undefined,
      "not an object",
      { usages: {} },
      { usages: { limit_5h: { used_ratio: "invalid-number" } } },
      { usage: { limit: "0", used: "0" } },
    ]) {
      const limits = kimiUsageResponseToLimits(invalid, checkedAt);
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Kimi Code usage limits could not be read.",
      });
      expect(limits.windows).toEqual([]);
    }
  });

  it("handles additional limit_* keys under usages as other kind", () => {
    const payload = {
      usages: {
        limit_30d: { used_ratio: 0.5, reset_time: "2026-11-20T00:00:00Z" },
      },
    };
    const limits = kimiUsageResponseToLimits(payload, checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "limit_30d",
        kind: "other",
        label: "Kimi Code limit_30d",
        usedPercent: 50,
        resetsAt: "2026-11-20T00:00:00Z",
        windowDurationMins: 43200,
      },
    ]);
  });
});

describe("readKimiCodeAccount", () => {
  it("returns unsupported when credential is missing or has unsupported format", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "kimi-auth-test-",
        });

        const noopClient = HttpClient.make(() =>
          Effect.die("must not call HTTP when credentials are missing or unsupported"),
        );

        // Case 1: auth.json does not exist
        const limitsMissing = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: path.join(tempDir, "missing"),
        }).pipe(Effect.provideService(HttpClient.HttpClient, noopClient));
        expect(limitsMissing.usageLimits.unavailable?.reason).toBe("unsupported");

        // Case 2: auth.json has no kimi-coding entry
        const emptyDir = path.join(tempDir, "empty");
        yield* fs.makeDirectory(emptyDir, { recursive: true });
        yield* fs.writeFileString(path.join(emptyDir, "auth.json"), JSON.stringify({}));
        const limitsEmpty = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: emptyDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, noopClient));
        expect(limitsEmpty.usageLimits.unavailable?.reason).toBe("unsupported");

        // Case 3: auth.json has kimi-coding with type !== "api_key"
        const wrongTypeDir = path.join(tempDir, "wrong-type");
        yield* fs.makeDirectory(wrongTypeDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(wrongTypeDir, "auth.json"),
          JSON.stringify({ "kimi-coding": { type: "oauth", token: "tok" } }),
        );
        const limitsWrongType = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: wrongTypeDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, noopClient));
        expect(limitsWrongType.usageLimits.unavailable?.reason).toBe("unsupported");

        // Case 4: auth.json has empty api_key
        const emptyKeyDir = path.join(tempDir, "empty-key");
        yield* fs.makeDirectory(emptyKeyDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(emptyKeyDir, "auth.json"),
          JSON.stringify({ "kimi-coding": { type: "api_key", key: "   " } }),
        );
        const limitsEmptyKey = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: emptyKeyDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, noopClient));
        expect(limitsEmptyKey.usageLimits.unavailable?.reason).toBe("unsupported");
      }),
    );
  });

  it("calls the usages endpoint with Bearer auth and parses response", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "kimi-auth-success-",
        });

        yield* fs.writeFileString(
          path.join(tempDir, "auth.json"),
          JSON.stringify({ "kimi-coding": { type: "api_key", key: "sk-kimi-secret" } }),
        );

        let requestedUrl = "";
        let authHeader = "";
        const mockClient = HttpClient.make((request) => {
          requestedUrl = request.url;
          authHeader = request.headers.authorization ?? "";
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usages: {
                  limit_5h: { used_ratio: 0.2, reset_time: "2026-10-22T14:09:30Z" },
                },
              }),
            ),
          );
        });

        const result = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: tempDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, mockClient));

        expect(requestedUrl).toBe("https://api.kimi.com/coding/v1/usages");
        expect(authHeader).toBe("Bearer sk-kimi-secret");
        expect(result.usageLimits.unavailable).toBeUndefined();
        expect(result.usageLimits.windows).toHaveLength(1);
        expect(result.usageLimits.windows[0]?.usedPercent).toBe(20);
      }),
    );
  });

  it("retries against /usage when /usages returns 404", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "kimi-auth-retry-",
        });

        yield* fs.writeFileString(
          path.join(tempDir, "auth.json"),
          JSON.stringify({ "kimi-coding": { type: "api_key", key: "sk-kimi-secret" } }),
        );

        const requestedUrls: string[] = [];
        const mockClient = HttpClient.make((request) => {
          requestedUrls.push(request.url);
          if (request.url === "https://api.kimi.com/coding/v1/usages") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usages: {
                  limit_5h: { used_ratio: 0.15, reset_time: "2026-10-22T14:09:30Z" },
                },
              }),
            ),
          );
        });

        const result = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: tempDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, mockClient));

        expect(requestedUrls).toEqual([
          "https://api.kimi.com/coding/v1/usages",
          "https://api.kimi.com/coding/v1/usage",
        ]);
        expect(result.usageLimits.unavailable).toBeUndefined();
        expect(result.usageLimits.windows[0]?.usedPercent).toBe(15);
      }),
    );
  });

  it("returns probeFailed when HTTP request fails", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "kimi-auth-err-",
        });

        yield* fs.writeFileString(
          path.join(tempDir, "auth.json"),
          JSON.stringify({ "kimi-coding": { type: "api_key", key: "sk-kimi-secret" } }),
        );

        const failingClient = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("Internal Server Error", { status: 500 }),
            ),
          ),
        );

        const result = yield* readKimiCodeAccount({
          PI_CODING_AGENT_DIR: tempDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, failingClient));

        expect(result.usageLimits.unavailable).toEqual({
          reason: "probeFailed",
          message: "Kimi Code usage limits could not be read.",
        });
      }),
    );
  });
});
