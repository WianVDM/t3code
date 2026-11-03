// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ContextBridgeSettings } from "@t3tools/contracts";

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
  tempRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "context-bridge-"),
  );
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
    // pi natively loads CLAUDE.local.md but not .claude/CLAUDE.local.md.
    writeFixture("project/CLAUDE.local.md", "native local overrides");
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
    expect(resolution!.block).not.toContain("native local overrides");

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
      status: "skipped",
      reason: "native-path",
    });
    expect(byPath.get(NodePath.join(cwd, ".claude", "CLAUDE.local.md"))).toMatchObject({
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
});
