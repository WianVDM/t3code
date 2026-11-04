import { defineConfig } from "@coderabbitai/config";

export default defineConfig({
  reviews: {
    profile: "chill",
    high_level_summary: false,
    review_status: false,
    commit_status: false,
    request_changes_workflow: false,
    allow_author_approval: false,
    auto_review: {
      enabled: true,
      drafts: false,
    },
    pre_merge_checks: {
      docstrings: { mode: "off" },
    },
    path_filters: ["!.repos/**"],
    path_instructions: [
      {
        path: "**",
        instructions:
          "Formatting, import order, naming and other lint-covered nits are enforced by CI. Never comment on them.",
      },
      {
        path: "{apps,packages,infra}/**/*.ts",
        instructions: "Hold changed code to the rules in docs/internals/effect-services.md.",
      },
      {
        path: "apps/web/src/**/*.{tsx,css}",
        instructions: "Hold changed code to the rules in docs/internals/web-ui.md.",
      },
      {
        path: "**/*.test.*",
        instructions:
          "Hold changed tests to the rules in docs/internals/testing.md. Request tests only as those rules allow.",
      },
    ],
  },
  knowledge_base: {
    code_guidelines: {
      filePatterns: [
        { files: "docs/internals/effect-services.md", applyTo: "{apps,packages,infra}/**/*.ts" },
        { files: "docs/internals/web-ui.md", applyTo: "apps/web/src/**/*.{tsx,css}" },
        { files: "docs/internals/testing.md", applyTo: "{apps,packages,infra}/**/*.{ts,tsx}" },
      ],
    },
  },
});
