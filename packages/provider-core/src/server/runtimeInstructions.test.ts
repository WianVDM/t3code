import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each([undefined, ""])("is byte-identical without bridged context (%s)", (bridgedContext) => {
    expect(buildRuntimeInstructions({ harness: "Codex", bridgedContext })).toBe(
      buildRuntimeInstructions({ harness: "Codex" }),
    );
  });

  it("appends non-empty bridged context after a blank line", () => {
    const base = buildRuntimeInstructions({ harness: "Codex" });
    expect(
      buildRuntimeInstructions({ harness: "Codex", bridgedContext: "<project_context />" }),
    ).toBe(`${base}\n\n<project_context />`);
  });
});
