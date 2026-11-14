import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeCanPushRepository, makeIsRepositoryStarred, makeStarRepository } from "./driver.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

describe("push access", () => {
  it.effect("returns true only when GitHub reports push permission", () => {
    const inputs: Array<GitHubRest.GitHubRestInput> = [];
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) => {
        inputs.push(input);
        return Effect.succeed({
          status: 200,
          headers: {},
          body: JSON.stringify({ permissions: { push: true } }),
          truncated: false,
          invalidUtf8: false,
        });
      },
    });
    return Effect.gen(function* () {
      const canPush = yield* makeCanPushRepository;
      assert.isTrue(yield* canPush("github.com", "WianVDM/t3code"));
      assert.deepStrictEqual(inputs, [
        {
          host: "github.com",
          operation: "canPushRepository",
          path: "repos/WianVDM/t3code",
          allowReserve: false,
        },
      ]);
    }).pipe(Effect.provide(api));
  });

  it.effect.each([
    {
      name: "push false",
      answer: () =>
        Effect.succeed({
          status: 200,
          headers: {},
          body: JSON.stringify({ permissions: { push: false } }),
          truncated: false,
          invalidUtf8: false,
        }),
    },
    {
      name: "missing permissions",
      answer: () =>
        Effect.succeed({
          status: 200,
          headers: {},
          body: "{}",
          truncated: false,
          invalidUtf8: false,
        }),
    },
    {
      name: "404",
      answer: () =>
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiNotFoundError({
            host: "github.com",
            operation: "canPushRepository",
          }),
        ),
    },
    {
      name: "credential failure",
      answer: () =>
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiRequestError({
            host: "github.com",
            operation: "canPushRepository",
            cause: new Error("No GitHub credential"),
          }),
        ),
    },
  ])("returns false for $name", ({ answer }) => {
    const api = Layer.mock(GitHubRest.GitHubRest)({ rest: answer });
    return Effect.gen(function* () {
      const canPush = yield* makeCanPushRepository;
      assert.isFalse(yield* canPush("github.com", "WianVDM/t3code"));
    }).pipe(Effect.provide(api));
  });
});

describe("starred", () => {
  it.effect("checks and stars only a valid repository, true only on 204", () => {
    const paths: Array<string> = [];
    const starred = new Set(["user/starred/pingdotgg/t3code"]);
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) => {
        paths.push(`${input.method ?? "GET"} ${input.path}`);
        return starred.has(input.path)
          ? Effect.succeed({
              status: 204,
              headers: {},
              body: "",
              truncated: false,
              invalidUtf8: false,
            })
          : Effect.fail(
              new GitHubRequestPolicy.GitHubApiNotFoundError({
                host: input.host,
                operation: input.operation,
              }),
            );
      },
    });
    return Effect.gen(function* () {
      const isStarred = yield* makeIsRepositoryStarred;
      const star = yield* makeStarRepository;
      assert.isTrue(yield* isStarred("github.com", "pingdotgg/t3code"));
      assert.isFalse(yield* isStarred("github.com", "pingdotgg/uploadthing"));
      assert.isFalse(yield* isStarred("github.com", "pingdotgg/t3code/../../user"));
      assert.isFalse(yield* isStarred("github.com", "../repos"));
      assert.isTrue(yield* star("github.com", "pingdotgg/t3code"));
      assert.isFalse(yield* star("github.com", "pingdotgg/uploadthing"));
      assert.isFalse(yield* star("github.com", "pingdotgg/t3code/../../user"));
      assert.isFalse(yield* star("github.com", "../repos"));
      assert.deepStrictEqual(paths, [
        "GET user/starred/pingdotgg/t3code",
        "GET user/starred/pingdotgg/uploadthing",
        "PUT user/starred/pingdotgg/t3code",
        "PUT user/starred/pingdotgg/uploadthing",
      ]);
    }).pipe(Effect.provide(api));
  });
});
