// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ContextBridgeSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildBridgedInstructions,
  resolveBridgedInstructions,
  resolveBridgedSkillRoots,
  resolveContextBridgeSource,
} from "./contextBridge.ts";

const decodeSettings = Schema.decodeSync(ContextBridgeSettings);

let tempRoot: string;
let userHome: string;
let cwd: string;

function writeFixture(relativePath: string, content: string, base = tempRoot): string {
  const filePath = NodePath.join(base, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, content, "utf8");
  return filePath;
}

beforeEach(() => {
  // Fixtures must not sit below the user profile; ancestor walks run to the
  // filesystem root, so real files like ~/.claude/CLAUDE.md would leak in as
  // project instructions. On Windows the OS temp dir is inside the profile,
  // so use Windows\Temp instead; POSIX temp is already outside it.
  const tempBase =
    HostProcess.Platform.defaultValue() === "win32"
      ? NodePath.join(process.env.SystemDrive ?? "C:", "\\", "Windows", "Temp")
      : NodeFS.realpathSync(NodeOS.tmpdir());
  tempRoot = NodeFS.mkdtempSync(NodePath.join(tempBase, "context-bridge-"));
  userHome = NodePath.join(tempRoot, "home");
  cwd = NodePath.join(tempRoot, "project");
  NodeFS.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
});

describe("resolveContextBridgeSource", () => {
  it("returns null when disabled", () => {
    const settings = decodeSettings({
      enabled: false,
      routes: { codex: { instructions: "default" } },
    });
    expect(resolveContextBridgeSource(settings, "codex", "instructions")).toBeNull();
  });

  it("returns null for a missing or native route", () => {
    const settings = decodeSettings({ enabled: true, routes: { codex: { skills: "pi" } } });
    expect(resolveContextBridgeSource(settings, "codex", "instructions")).toBeNull();
    expect(resolveContextBridgeSource(settings, "cursor", "skills")).toBeNull();
    expect(
      resolveContextBridgeSource(
        decodeSettings({ enabled: true, routes: { pi: { instructions: "native" } } }),
        "pi",
        "instructions",
      ),
    ).toBeNull();
  });

  it('resolves "default" to defaultSource and explicit targets directly', () => {
    const settings = decodeSettings({
      enabled: true,
      defaultSource: "pi",
      routes: { codex: { instructions: "default" }, cursor: { skills: "opencode" } },
    });
    expect(resolveContextBridgeSource(settings, "codex", "instructions")).toBe("pi");
    expect(resolveContextBridgeSource(settings, "cursor", "skills")).toBe("opencode");
  });

  it("returns null for unknown drivers, unknown sources, and source equal to target", () => {
    const settings = decodeSettings({
      enabled: true,
      routes: {
        codex: { instructions: "someFutureDriver" },
        claudeAgent: { instructions: "claudeAgent" },
      },
    });
    expect(resolveContextBridgeSource(settings, "codex", "instructions")).toBeNull();
    expect(resolveContextBridgeSource(settings, "claudeAgent", "instructions")).toBeNull();
    expect(resolveContextBridgeSource(settings, "someFutureDriver", "instructions")).toBeNull();
  });
});

describe("buildBridgedInstructions", () => {
  const bridgedToCodex = decodeSettings({
    enabled: true,
    routes: { codex: { instructions: "default" } },
  });

  it('returns "" when disabled or native', () => {
    writeFixture("project/CLAUDE.md", "project rules");
    expect(
      buildBridgedInstructions({
        settings: decodeSettings({
          enabled: false,
          routes: { codex: { instructions: "default" } },
        }),
        targetDriver: "codex",
        cwd,
        userHome,
      }),
    ).toBe("");
    expect(
      buildBridgedInstructions({
        settings: decodeSettings({ enabled: true }),
        targetDriver: "codex",
        cwd,
        userHome,
      }),
    ).toBe("");
  });

  it('returns "" when the source equals the target', () => {
    writeFixture("project/CLAUDE.md", "project rules");
    expect(
      buildBridgedInstructions({
        settings: decodeSettings({
          enabled: true,
          routes: { claudeAgent: { instructions: "claudeAgent" } },
        }),
        targetDriver: "claudeAgent",
        cwd,
        userHome,
      }),
    ).toBe("");
  });

  it("bridges global, project, and local files in precedence order", () => {
    writeFixture("home/.claude/CLAUDE.md", "GLOBAL MARKER");
    const nestedCwd = NodePath.join(cwd, "nested");
    NodeFS.mkdirSync(nestedCwd, { recursive: true });
    writeFixture("project/nested/CLAUDE.md", "PROJECT MARKER");
    writeFixture("project/CLAUDE.local.md", "ANCESTOR LOCAL MARKER");
    writeFixture("project/nested/CLAUDE.local.md", "CWD LOCAL MARKER");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd: nestedCwd,
      userHome,
    });

    expect(block).toContain("<!-- t3-context-bridge -->");
    expect(block).toContain('<project_context source="claudeAgent" target="codex">');
    expect(block).toContain("Global user instructions bridged by T3 Context Bridge");
    expect(block).toContain("Project instructions bridged by T3 Context Bridge");
    expect(block).toContain("Local override instructions (*.local.md)");
    expect(block.indexOf("GLOBAL MARKER")).toBeLessThan(block.indexOf("PROJECT MARKER"));
    expect(block.indexOf("PROJECT MARKER")).toBeLessThan(block.indexOf("ANCESTOR LOCAL MARKER"));
    expect(block.indexOf("ANCESTOR LOCAL MARKER")).toBeLessThan(block.indexOf("CWD LOCAL MARKER"));
  });

  it("includes the global CLAUDE.local.md once, after project instructions", () => {
    writeFixture("home/.claude/CLAUDE.md", "GLOBAL MARKER");
    writeFixture("home/.claude/CLAUDE.local.md", "GLOBAL LOCAL MARKER");
    writeFixture("project/CLAUDE.md", "PROJECT MARKER");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });

    expect(block.split("GLOBAL MARKER").length - 1).toBe(1);
    expect(block.split("GLOBAL LOCAL MARKER").length - 1).toBe(1);
    expect(block.split("PROJECT MARKER").length - 1).toBe(1);
    expect(block).toContain("Global user instructions bridged by T3 Context Bridge");
    expect(block).toContain("Project instructions bridged by T3 Context Bridge");
    expect(block).toContain("Local override instructions (*.local.md)");
    expect(block.indexOf("GLOBAL MARKER")).toBeLessThan(block.indexOf("PROJECT MARKER"));
    expect(block.indexOf("PROJECT MARKER")).toBeLessThan(block.indexOf("GLOBAL LOCAL MARKER"));
  });

  it("skips files the target harness loads natively", () => {
    // pi natively loads CLAUDE.md from the cwd, so bridging claudeAgent's
    // project CLAUDE.md into pi must not inject it a second time.
    writeFixture("project/CLAUDE.md", "shared project rules");
    expect(
      buildBridgedInstructions({
        settings: decodeSettings({
          enabled: true,
          routes: { pi: { instructions: "claudeAgent" } },
        }),
        targetDriver: "pi",
        cwd,
        userHome,
      }),
    ).toBe("");
  });

  it("skips files whose content is byte-identical to a natively loaded file", () => {
    // codex natively loads AGENTS.md; a CLAUDE.md with the same content must
    // not be bridged in on top of it.
    writeFixture("project/AGENTS.md", "identical rules\n");
    writeFixture("project/CLAUDE.md", "identical rules\n");
    expect(
      buildBridgedInstructions({
        settings: bridgedToCodex,
        targetDriver: "codex",
        cwd,
        userHome,
      }),
    ).toBe("");
  });

  it("skips byte-identical duplicates within the source", () => {
    writeFixture("home/.claude/CLAUDE.md", "same rules everywhere\n");
    writeFixture("project/CLAUDE.md", "same rules everywhere\n");
    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });
    expect(block).toContain("same rules everywhere");
    expect(block.indexOf("same rules everywhere")).toBe(block.lastIndexOf("same rules everywhere"));
  });

  it("expands a @AGENTS.md pointer in bridged CLAUDE.md for a non-Claude target", () => {
    // Claude instruction files can reference another file with an
    // `@path` import. A non-Claude target has no idea what that means, so
    // the bridge must inline the referenced content once: no literal
    // pointer left behind, no duplicated body.
    writeFixture("project/AGENTS.md", "SHARED AGENTS BODY\n");
    writeFixture("project/CLAUDE.md", "Top of CLAUDE.\n@AGENTS.md\nEnd of CLAUDE.\n");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });

    expect(block).toContain("SHARED AGENTS BODY");
    expect(block).not.toContain("@AGENTS.md");
    expect(block.indexOf("SHARED AGENTS BODY")).toBe(block.lastIndexOf("SHARED AGENTS BODY"));
  });

  it("inlines nested relative @ imports, each resolved against its own file", () => {
    // A pointer inside an inlined file is itself resolved relative to that
    // file's directory, not the cwd, and every successfully resolved body
    // lands exactly once with no raw pointer left anywhere in the block.
    writeFixture("project/CLAUDE.md", "Top of CLAUDE.\n@docs/A.md\nEnd of CLAUDE.\n");
    writeFixture("project/docs/A.md", "Body A.\n@B.md\n");
    writeFixture("project/docs/B.md", "Body B.\n");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });

    expect(block).toContain("Body A.");
    expect(block).toContain("Body B.");
    expect(block).not.toContain("@docs/A.md");
    expect(block).not.toContain("@B.md");
    expect(block.split("Body A.").length - 1).toBe(1);
    expect(block.split("Body B.").length - 1).toBe(1);
    expect(block.indexOf("Top of CLAUDE.")).toBeLessThan(block.indexOf("Body A."));
    expect(block.indexOf("Body A.")).toBeLessThan(block.indexOf("Body B."));
    expect(block.indexOf("Body B.")).toBeLessThan(block.indexOf("End of CLAUDE."));
  });

  it("terminates on cyclic @ imports and leaves only the cyclic pointer unchanged", () => {
    // A -> B -> A must not loop forever: readable non-cyclic content is
    // inlined once; the pointer that would re-enter the cycle stays raw as
    // fail-soft evidence of the skipped expansion.
    writeFixture("project/CLAUDE.md", "Top of CLAUDE.\n@docs/A.md\nEnd of CLAUDE.\n");
    writeFixture("project/docs/A.md", "Body A.\n@B.md\n");
    writeFixture("project/docs/B.md", "Body B.\n@A.md\n");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });

    expect(block).toContain("Body A.");
    expect(block).toContain("Body B.");
    expect(block.split("Body A.").length - 1).toBe(1);
    expect(block.split("Body B.").length - 1).toBe(1);
    expect(block).not.toContain("@docs/A.md");
    expect(block).not.toContain("@B.md");
    // Only the cyclic pointer survives as fail-soft evidence, exactly once.
    expect(block.split("@A.md").length - 1).toBe(1);
  });

  it("leaves an unresolvable @ import raw without disturbing surrounding content", () => {
    // A pointer to a missing file cannot be inlined; the bridge must not
    // throw. Surrounding content stays intact, the unresolved raw pointer
    // remains once, and nothing else repeats.
    writeFixture("project/CLAUDE.md", "Top of CLAUDE.\n@docs/missing.md\nEnd of CLAUDE.\n");
    writeFixture("project/docs/A.md", "Body A.\n");
    writeFixture("project/CLAUDE.local.md", "Body A.\n");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });

    expect(block).toContain("Top of CLAUDE.");
    expect(block).toContain("End of CLAUDE.");
    expect(block).toContain("Body A.");
    expect(block.split("Top of CLAUDE.").length - 1).toBe(1);
    expect(block.split("End of CLAUDE.").length - 1).toBe(1);
    expect(block.indexOf("Top of CLAUDE.")).toBeLessThan(block.indexOf("@docs/missing.md"));
    expect(block.indexOf("@docs/missing.md")).toBeLessThan(block.indexOf("End of CLAUDE."));
    expect(block.split("@docs/missing.md").length - 1).toBe(1);
    // No spurious content duplication elsewhere in the block.
    expect(block.indexOf("Body A.")).toBe(block.lastIndexOf("Body A."));
  });

  it("inlines nested relative @ imports with CRLF line endings and preserves unresolved pointers", () => {
    writeFixture(
      "project/CLAUDE.md",
      "Top of CLAUDE.\r\n@docs/A.md\r\n@docs/missing.md\r\nEnd of CLAUDE.\r\n",
    );
    writeFixture("project/docs/A.md", "Body A.\r\n@B.md\r\n");
    writeFixture("project/docs/B.md", "Body B.\r\n");

    const block = buildBridgedInstructions({
      settings: bridgedToCodex,
      targetDriver: "codex",
      cwd,
      userHome,
    });

    expect(block).toContain("Body A.");
    expect(block).toContain("Body B.");
    expect(block).toContain("@docs/missing.md");
    expect(block).not.toContain("@docs/A.md");
    expect(block).not.toContain("@B.md");
    expect(block.split("Body A.").length - 1).toBe(1);
    expect(block.split("Body B.").length - 1).toBe(1);
    expect(block.split("@docs/missing.md").length - 1).toBe(1);
    expect(block.indexOf("Top of CLAUDE.")).toBeLessThan(block.indexOf("Body A."));
    expect(block.indexOf("Body A.")).toBeLessThan(block.indexOf("Body B."));
    expect(block.indexOf("Body B.")).toBeLessThan(block.indexOf("@docs/missing.md"));
    expect(block.indexOf("@docs/missing.md")).toBeLessThan(block.indexOf("End of CLAUDE."));
  });

  it("dedupes the source global against pi's native agentDir global via nativeHome", () => {
    // pi's native globals live under its agentDir (PI_CODING_AGENT_DIR,
    // default ~/.pi/agent), not the user home. nativeHome maps that dir so a
    // source global with identical content is skipped as native-content,
    // while a differing body is still injected.
    const nativeHome = NodePath.join(tempRoot, "pi-agent");
    writeFixture("home/.claude/CLAUDE.md", "shared global rules\n");
    writeFixture("pi-agent/CLAUDE.md", "shared global rules\n");

    const identical = buildBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "claudeAgent" } },
      }),
      targetDriver: "pi",
      cwd,
      userHome,
      nativeHome,
    });
    expect(identical).toBe("");

    writeFixture("home/.claude/CLAUDE.md", "source-only global rules\n");
    const differing = buildBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "claudeAgent" } },
      }),
      targetDriver: "pi",
      cwd,
      userHome,
      nativeHome,
    });
    expect(differing).toContain("source-only global rules");
  });

  it("injects the expanded AGENTS.md body when pi's native CLAUDE.md holds an @AGENTS.md pointer", () => {
    // pi natively loads CLAUDE.md from the cwd, but unlike Claude it does not
    // resolve `@path` imports inside it, so the AGENTS.md body would never
    // reach the prompt. The bridge must inject the source CLAUDE.md with the
    // import inlined, not skip it as native-path or leave the raw pointer,
    // while ordinary no-import native files still dedupe by content.
    writeFixture("project/AGENTS.md", "SHARED AGENTS BODY\n");
    writeFixture("project/CLAUDE.md", "Top of CLAUDE.\n@AGENTS.md\nEnd of CLAUDE.\n");
    // Identical to pi's natively loaded AGENTS.md body: still native-content.
    writeFixture("home/.claude/CLAUDE.md", "SHARED AGENTS BODY\n");

    const resolution = resolveBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "claudeAgent" } },
      }),
      targetDriver: "pi",
      cwd,
      userHome,
    });

    expect(resolution).not.toBeNull();
    expect(resolution!.block).toContain("SHARED AGENTS BODY");
    expect(resolution!.block).toContain("Top of CLAUDE.");
    expect(resolution!.block).not.toContain("@AGENTS.md");
    expect(resolution!.block.indexOf("SHARED AGENTS BODY")).toBe(
      resolution!.block.lastIndexOf("SHARED AGENTS BODY"),
    );

    const byPath = new Map(resolution!.files.map((file) => [file.path, file]));
    expect(byPath.get(NodePath.join(cwd, "CLAUDE.md"))).toMatchObject({ status: "injected" });
    expect(byPath.get(NodePath.join(userHome, ".claude", "CLAUDE.md"))).toMatchObject({
      tier: "global",
      status: "skipped",
      reason: "native-content",
    });
  });

  it('ignores missing files and returns "" when nothing exists', () => {
    expect(
      buildBridgedInstructions({ settings: bridgedToCodex, targetDriver: "codex", cwd, userHome }),
    ).toBe("");
  });
});

describe("resolveBridgedInstructions", () => {
  it("returns null when no instructions route applies", () => {
    expect(
      resolveBridgedInstructions({
        settings: decodeSettings({ enabled: false }),
        targetDriver: "pi",
        cwd,
        userHome,
      }),
    ).toBeNull();
    expect(
      resolveBridgedInstructions({
        settings: decodeSettings({ enabled: true }),
        targetDriver: "pi",
        cwd,
        userHome,
      }),
    ).toBeNull();
  });

  it("reports injected and skipped files with reasons for a pi target", () => {
    writeFixture("home/.claude/CLAUDE.md", "global claude rules");
    // pi natively loads CLAUDE.md from the cwd: native-path skip.
    writeFixture("project/CLAUDE.md", "shared project rules");
    // pi natively loads AGENTS.md too: a bridged copy is native-content.
    writeFixture("project/AGENTS.md", "native agents rules");
    writeFixture("project/.claude/CLAUDE.md", "native agents rules");
    // pi does not natively load CLAUDE.local.md: bridged as a local override.
    writeFixture("project/CLAUDE.local.md", "project local overrides");
    writeFixture("project/.claude/CLAUDE.local.md", "bridged local overrides");

    const resolution = resolveBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "claudeAgent" } },
      }),
      targetDriver: "pi",
      cwd,
      userHome,
    });

    expect(resolution).not.toBeNull();
    expect(resolution!.source).toBe("claudeAgent");
    expect(resolution!.block).toContain("global claude rules");
    expect(resolution!.block).toContain("bridged local overrides");
    expect(resolution!.block).not.toContain("shared project rules");
    expect(resolution!.block).not.toContain("native agents rules");
    expect(resolution!.block).toContain("project local overrides");

    const byPath = new Map(resolution!.files.map((file) => [file.path, file]));
    expect(byPath.get(NodePath.join(userHome, ".claude", "CLAUDE.md"))).toMatchObject({
      tier: "global",
      status: "injected",
    });
    expect(byPath.get(NodePath.join(cwd, "CLAUDE.md"))).toMatchObject({
      tier: "project",
      status: "skipped",
      reason: "native-path",
    });
    expect(byPath.get(NodePath.join(cwd, ".claude", "CLAUDE.md"))).toMatchObject({
      status: "skipped",
      reason: "native-content",
    });
    expect(byPath.get(NodePath.join(cwd, "CLAUDE.local.md"))).toMatchObject({
      tier: "local",
      status: "injected",
    });
    expect(byPath.get(NodePath.join(cwd, ".claude", "CLAUDE.local.md"))).toMatchObject({
      tier: "local",
      status: "injected",
    });
  });

  it("skips an ancestor CLAUDE.md natively loaded by pi for a nested cwd", () => {
    // pi walks up from the cwd and natively loads CLAUDE.md from ancestors,
    // so a bridged ancestor copy must be skipped as native-path, not injected.
    const nestedCwd = NodePath.join(cwd, "nested");
    NodeFS.mkdirSync(nestedCwd, { recursive: true });
    writeFixture("project/CLAUDE.md", "ancestor project rules");
    writeFixture("project/nested/CLAUDE.md", "cwd project rules");

    const resolution = resolveBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "claudeAgent" } },
      }),
      targetDriver: "pi",
      cwd: nestedCwd,
      userHome,
    });

    expect(resolution).not.toBeNull();
    expect(resolution!.block).not.toContain("ancestor project rules");
    expect(resolution!.block).not.toContain("cwd project rules");

    const byPath = new Map(resolution!.files.map((file) => [file.path, file]));
    expect(byPath.get(NodePath.join(cwd, "CLAUDE.md"))).toMatchObject({
      tier: "project",
      status: "skipped",
      reason: "native-path",
    });
    expect(byPath.get(NodePath.join(nestedCwd, "CLAUDE.md"))).toMatchObject({
      tier: "project",
      status: "skipped",
      reason: "native-path",
    });
  });

  it("injects project CLAUDE.local.md and AGENTS.local.md for a pi target", () => {
    // pi does not natively load project-local override files from the cwd,
    // so bridged copies must be injected, not skipped as native-path.
    writeFixture("project/CLAUDE.local.md", "project claude local overrides");
    writeFixture("project/AGENTS.local.md", "project agents local overrides");

    const resolution = resolveBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "opencode" } },
      }),
      targetDriver: "pi",
      cwd,
      userHome,
    });

    expect(resolution).not.toBeNull();
    expect(resolution!.block).toContain("project claude local overrides");
    expect(resolution!.block).toContain("project agents local overrides");

    const byPath = new Map(resolution!.files.map((file) => [file.path, file]));
    expect(byPath.get(NodePath.join(cwd, "CLAUDE.local.md"))).toMatchObject({
      tier: "local",
      status: "injected",
    });
    expect(byPath.get(NodePath.join(cwd, "AGENTS.local.md"))).toMatchObject({
      tier: "local",
      status: "injected",
    });
  });

  it("emits duplicate ancestor content once while distinct ancestor content stays, for a nested cwd", () => {
    // Walking up from a nested cwd discovers the same instruction content
    // through two ancestor paths: it lands once in the block, the later
    // discovery is skipped as duplicate-content, and a distinct ancestor
    // file is still injected.
    const nestedCwd = NodePath.join(cwd, "nested");
    NodeFS.mkdirSync(nestedCwd, { recursive: true });
    writeFixture("project/CLAUDE.md", "shared ancestor rules");
    writeFixture("project/nested/CLAUDE.md", "shared ancestor rules");
    writeFixture("project/CLAUDE.local.md", "distinct ancestor local overrides");

    const resolution = resolveBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { codex: { instructions: "default" } },
      }),
      targetDriver: "codex",
      cwd: nestedCwd,
      userHome,
    });

    expect(resolution).not.toBeNull();
    expect(resolution!.block).toContain("shared ancestor rules");
    expect(resolution!.block).toContain("distinct ancestor local overrides");
    expect(resolution!.block.split("shared ancestor rules").length - 1).toBe(1);
    expect(resolution!.block.split("distinct ancestor local overrides").length - 1).toBe(1);

    const byPath = new Map(resolution!.files.map((file) => [file.path, file]));
    const claudeEntries = [
      byPath.get(NodePath.join(cwd, "CLAUDE.md")),
      byPath.get(NodePath.join(nestedCwd, "CLAUDE.md")),
    ];
    expect(claudeEntries.filter((entry) => entry?.status === "injected")).toHaveLength(1);
    expect(claudeEntries.filter((entry) => entry?.reason === "duplicate-content")).toHaveLength(1);
    expect(byPath.get(NodePath.join(cwd, "CLAUDE.local.md"))).toMatchObject({
      tier: "local",
      status: "injected",
    });
  });

  it("returns an empty block when every existing file is skipped", () => {
    writeFixture("project/CLAUDE.md", "shared project rules");
    const resolution = resolveBridgedInstructions({
      settings: decodeSettings({
        enabled: true,
        routes: { pi: { instructions: "claudeAgent" } },
      }),
      targetDriver: "pi",
      cwd,
      userHome,
    });
    expect(resolution).toMatchObject({ source: "claudeAgent", block: "" });
    expect(resolution!.files).toHaveLength(1);
    expect(resolution!.files[0]).toMatchObject({ status: "skipped", reason: "native-path" });
  });
});

describe("resolveBridgedSkillRoots", () => {
  it("returns null when skills are native for the target", () => {
    const settings = decodeSettings({ enabled: true, routes: { codex: { skills: "native" } } });
    expect(resolveBridgedSkillRoots({ settings, targetDriver: "codex", cwd, userHome })).toBeNull();
    expect(
      resolveBridgedSkillRoots({
        settings: decodeSettings({ enabled: false }),
        targetDriver: "codex",
        cwd,
        userHome,
      }),
    ).toBeNull();
  });

  it("expands the source provider's global and project skill roots", () => {
    const settings = decodeSettings({
      enabled: true,
      routes: { codex: { skills: "default" } },
    });
    expect(resolveBridgedSkillRoots({ settings, targetDriver: "codex", cwd, userHome })).toEqual({
      global: [NodePath.join(userHome, ".claude", "skills")],
      project: [NodePath.join(cwd, ".claude", "skills")],
    });
  });

  it("returns no project roots without a cwd", () => {
    const settings = decodeSettings({
      enabled: true,
      routes: { codex: { skills: "default" } },
    });
    expect(
      resolveBridgedSkillRoots({ settings, targetDriver: "codex", cwd: undefined, userHome }),
    ).toEqual({
      global: [NodePath.join(userHome, ".claude", "skills")],
      project: [],
    });
  });

  it("filters roots the target already loads natively", () => {
    // pi loads ~/.claude/skills by itself; bridging claudeAgent's skills into
    // pi must not register that root a second time.
    const settings = decodeSettings({
      enabled: true,
      routes: { pi: { skills: "claudeAgent" } },
    });
    expect(resolveBridgedSkillRoots({ settings, targetDriver: "pi", cwd, userHome })).toEqual({
      global: [],
      project: [NodePath.join(cwd, ".claude", "skills")],
    });
  });

  it("keeps the claudeAgent global root when pi's nativeHome is a custom agent dir", () => {
    // With a custom PI_CODING_AGENT_DIR, pi's native skill discovery is
    // rooted at that dir and no longer loads ~/.claude/skills by itself.
    // The bridge must still include the claudeAgent global root so skills
    // like /voice stay discoverable, instead of filtering it as native.
    const nativeHome = NodePath.join(tempRoot, "pi-agent");
    const settings = decodeSettings({
      enabled: true,
      routes: { pi: { skills: "claudeAgent" } },
    });
    expect(
      resolveBridgedSkillRoots({ settings, targetDriver: "pi", cwd, userHome, nativeHome }),
    ).toEqual({
      global: [NodePath.join(userHome, ".claude", "skills")],
      project: [NodePath.join(cwd, ".claude", "skills")],
    });
  });

  it("keeps project-native roots deduped under a custom nativeHome at the project root", () => {
    // pi discovers project .pi/skills and .agents/skills itself whether or
    // not its agent dir moved, so a custom nativeHome must not un-filter
    // them; codex's bridged .agents/skills root would otherwise register a
    // second time alongside pi's own discovery.
    const nativeHome = NodePath.join(tempRoot, "pi-agent");
    const settings = decodeSettings({
      enabled: true,
      routes: { pi: { skills: "codex" } },
    });
    expect(
      resolveBridgedSkillRoots({ settings, targetDriver: "pi", cwd, userHome, nativeHome }),
    ).toEqual({
      global: [NodePath.join(userHome, ".codex", "skills")],
      project: [NodePath.join(cwd, ".codex", "skills")],
    });
  });

  it("keeps project-native roots deduped through cwd ancestors for a nested cwd", () => {
    // Same guarantee one level down: pi walks the whole ancestor chain for
    // .pi/skills and .agents/skills, so a nested cwd must not bridge a
    // directory pi already registers natively.
    const nestedCwd = NodePath.join(cwd, "nested");
    NodeFS.mkdirSync(nestedCwd, { recursive: true });
    const nativeHome = NodePath.join(tempRoot, "pi-agent");
    const settings = decodeSettings({
      enabled: true,
      routes: { pi: { skills: "codex" } },
    });
    expect(
      resolveBridgedSkillRoots({
        settings,
        targetDriver: "pi",
        cwd: nestedCwd,
        userHome,
        nativeHome,
      }),
    ).toEqual({
      global: [NodePath.join(userHome, ".codex", "skills")],
      project: [NodePath.join(nestedCwd, ".codex", "skills")],
    });
  });
});
