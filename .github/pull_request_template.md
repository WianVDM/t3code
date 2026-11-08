<!--
T3 Code (fork) is solo-maintained for personal use. External PRs are handled
best-effort and are most likely to land as a small, single-problem change.
Use a conventional commit title in plain language, such as
"fix(web): new threads no longer spike CPU". PRs are squash merged, so the
title becomes the commit message.
-->

## Traceability

<!-- Required by #43. Link this PR to a same-repository issue carrying the
`accepted` label, using exactly one form:

- `Closes #<number>` when this PR completes the issue.
- `Part of #<number>` when this PR is one step of larger accepted work, such
  as a stacked PR.

Only same-repository issues count: cross-repository references, pull request
links, and bare numbers do not satisfy the check. Replace the placeholder
below; an unedited placeholder is reported as a malformed link. The Issue
Traceability check runs advisedly during bootstrap and becomes a required
check at the #43 enforcement milestone (B12). -->

Part of #

## Problem

<!-- One or two sentences. Expected behavior plus reproduction steps or
environment where relevant. -->

## Change

<!-- How this fixes the problem. If it spans components or clients, say why
each change is needed for the same fix. Independent fixes belong in separate
PRs.

Stacked PR? Name the base branch or parent PR here. -->

## Compatibility

<!-- Required if the change touches persisted or shared state: thread/project
data, the sqlite schema, event or outbox shapes, contracts, provider session
state, or anything an existing client or environment reads. State whether
existing data and mixed-version clients keep working, and how you know. -->

## Verification

<!-- The focused tests or manual checks you ran for the changed behavior, with
observed results. Say what you could not check. "Tests pass" alone is not
enough; CI plus the specific check that covers this change is.

UI changes: before/after screenshots. Motion, timing, or interaction details:
a short recording. Attach to the PR body, never to the repo. -->

<!-- If an agent did the work, end with the model and harness. -->
