import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_BUILTIN_LOCAL_COMMANDS,
  planClaudeSkillDispatch,
  type ClaudeSkillTarget,
} from "./ClaudeSkillDispatch.ts";

const shadowedNote = (name: string, path: string, tail: string) =>
  `The user invoked the "${name}" skill. Claude Code's built-in /${name} command shadows it, so read and follow the skill instructions at: ${path}.${tail.trim().length > 0 ? ` Arguments:${tail}` : ""}`;

const skillPath = (name: string) => `/home/me/.claude/skills/${name}/SKILL.md`;

const skillMap = (names: Iterable<string>) =>
  new Map<string, ClaudeSkillTarget>([...names].map((name) => [name, { path: skillPath(name) }]));

const SKILLS = skillMap(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  // regression: #9128 skills picked from the composer did not run
  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("keeps the whole request ahead of a mid-prompt slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now /implement all the tickets",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then /implement the fixes",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("dispatches currency-prefixed mentions and preserves their source boundaries", () => {
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `${symbol}review the diff, then ${symbol}implement the fixes`,
          SKILLS,
        ),
      ).toEqual({
        leadingText: "/review the diff, then /implement the fixes",
        commandText: "/implement the fixes",
        skillName: "implement",
      });
      expect(planClaudeSkillDispatch(`${symbol}2spec for this`, SKILLS)).toEqual({
        leadingText: undefined,
        commandText: "/2spec for this",
        skillName: "2spec",
      });
      expect(planClaudeSkillDispatch(`5${symbol}review ${symbol}unknown`, SKILLS)).toBeUndefined();
    }
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = skillMap([...SKILLS.keys(), "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });

  it("bounds notes for repeated user-only skills and leaves the native dispatch unannotated", () => {
    const skills = new Map([
      ["interrogate", { path: skillPath("interrogate"), userInvocationOnly: true }],
      ["implement", { path: skillPath("implement"), userInvocationOnly: true }],
    ]);
    expect(
      planClaudeSkillDispatch(
        "$interrogate then $interrogate then $implement and $implement the fixes",
        skills,
      ),
    ).toEqual({
      leadingText: `/interrogate [The user invoked this skill. Follow the instructions at: ${skillPath("interrogate")}] then /interrogate then /implement and /implement the fixes`,
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("falls back to reading the exact skill file for a built-in-shadowed skill", () => {
    // `/voice` is intercepted by Claude Code's built-in voice command
    // (unavailable_headless in headless sessions) before the user skill can
    // expand, and the Skill tool is not used, so the dispatch names the exact
    // SKILL.md path and the arguments instead of a slash command.
    const path = skillPath("voice");
    expect(planClaudeSkillDispatch("$voice read me the summary", skillMap(["voice"]))).toEqual({
      leadingText: undefined,
      commandText: shadowedNote("voice", path, " read me the summary"),
      skillName: "voice",
    });
    expect(planClaudeSkillDispatch("please $voice now", skillMap(["voice"]))).toEqual({
      leadingText: "please /voice now",
      commandText: shadowedNote("voice", path, " now"),
      skillName: "voice",
    });
  });

  it("omits the Arguments suffix when a shadowed skill dispatch has no trailing text", () => {
    const path = skillPath("voice");
    expect(planClaudeSkillDispatch("$voice", skillMap(["voice"]))).toEqual({
      leadingText: undefined,
      commandText: shadowedNote("voice", path, ""),
      skillName: "voice",
    });
    expect(planClaudeSkillDispatch("$voice", skillMap(["voice"]))?.commandText).not.toContain(
      "Arguments:",
    );
  });

  it("falls back to the exact file for every built-in-shadowed name", () => {
    for (const name of CLAUDE_BUILTIN_LOCAL_COMMANDS) {
      const path = skillPath(name);
      expect(planClaudeSkillDispatch(`$${name} do the thing`, skillMap([name]))).toEqual({
        leadingText: undefined,
        commandText: shadowedNote(name, path, " do the thing"),
        skillName: name,
      });
    }
  });

  it("never dispatches a Skill-tool call or a built-in slash command for a shadowed skill", () => {
    for (const name of CLAUDE_BUILTIN_LOCAL_COMMANDS) {
      const dispatch = planClaudeSkillDispatch(`$${name} do the thing`, skillMap([name]));
      expect(dispatch?.commandText).not.toContain("Skill tool");
      expect(dispatch?.commandText).not.toMatch(new RegExp(`^/${name}(?:\\s|$)`));
    }
  });

  it("keeps the native dispatch when only an earlier mention is shadowed", () => {
    expect(
      planClaudeSkillDispatch(
        "$voice now, then $implement the fixes",
        skillMap(["voice", "implement"]),
      ),
    ).toEqual({
      leadingText: "/voice now, then /implement the fixes",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("keeps the file-note annotation for earlier user-only skills a built-in shadows", () => {
    const skills = new Map<string, ClaudeSkillTarget>([
      ["voice", { path: skillPath("voice"), userInvocationOnly: true }],
      ["implement", { path: skillPath("implement") }],
    ]);
    expect(planClaudeSkillDispatch("$voice now then $implement the fixes", skills)).toEqual({
      leadingText: `/voice [The user invoked this skill. Follow the instructions at: ${skillPath("voice")}] now then /implement the fixes`,
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("falls back to the file note when a shadowed user-only skill is the dispatch", () => {
    // The Skill tool refuses disable-model-invocation skills, so a shadowed
    // slash form leaves the file note as the only route that still runs the
    // discovered SKILL.md.
    const skills = new Map<string, ClaudeSkillTarget>([
      ["voice", { path: skillPath("voice"), userInvocationOnly: true }],
    ]);
    expect(planClaudeSkillDispatch("please $voice now", skills)).toEqual({
      leadingText: "please /voice now",
      commandText: `The user invoked this skill. Follow the instructions at: ${skillPath("voice")} now`,
      skillName: "voice",
    });
  });
});
