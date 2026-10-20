// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, beforeEach, afterEach } from "vite-plus/test";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ContextBridgeSettings } from "@t3tools/contracts";

import {
  buildBridgedInstructions,
  resolveBridgedSkillRoots,
  resolveContextBridgeSource,
} from "./contextBridge.ts";

const decodeSettings = Schema.decodeSync(ContextBridgeSettings);

let tempRoot: string;
let userHome: string;
let cwd: string;

function writeFixture(relativePath: string, content: string, base = tempRoot): string {
  const filePath = NodePath.join(base, relativePath);
  NodeFs.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

beforeEach(() => {
  tempRoot = NodeFs.mkdtempSync(
    NodePath.join(NodeFs.realpathSync(NodeOs.tmpdir()), "context-bridge-"),
  );
  userHome = NodePath.join(tempRoot, "home");
  cwd = NodePath.join(tempRoot, "project");
  NodeFs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  NodeFs.rmSync(tempRoot, { recursive: true, force: true });
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
    NodeFs.mkdirSync(nestedCwd, { recursive: true });
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
});
