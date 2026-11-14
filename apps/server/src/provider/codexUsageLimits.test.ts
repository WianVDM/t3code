import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";

import { codexRateLimitsFailureMessage } from "./codexUsageLimits.ts";

// SDK parity: the facade accepts real app-server error values.
describe("codexRateLimitsFailureMessage", () => {
  it("keeps the JSON-RPC code and nothing else from a request failure", () => {
    expect(
      codexRateLimitsFailureMessage(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage:
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized",
        }),
      ),
    ).toBe("Codex could not read usage (JSON-RPC -32603).");
  });
});
