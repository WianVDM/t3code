# Contributing

This is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), maintained by one person
for their own use. External pull requests are welcome on a best-effort basis. Opening one does not
create an obligation to review, merge, or reply, and a change that suits a different setup than the
fork owner's may still be declined.

Focused bug fixes, reliability fixes, performance improvements, and small maintenance changes are the
most likely to land. Unsolicited features, opinionated rewrites, and unrelated cleanup usually are not.

## Developer setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

## Before starting

- Report bugs in issues, and search existing issues and the docs before starting work.
- Open an issue for anything beyond a small, obvious fix so scope can be settled before you spend
  time on it. A quick "is this wanted?" costs less than a rejected PR.
- Features that belong upstream are better raised at
  [pingdotgg/t3code](https://github.com/pingdotgg/t3code) first. This fork tracks upstream stable, so
  a change that cannot survive the next sync is expensive to keep.

<a id="one-problem"></a>

## Solve one problem per PR

One coherent change per PR. A PR that fixes several independent problems must be split, even when
each fix is useful. Count the underlying problems, not the linked issues; several reports may describe
the same defect.

Include the contract, server, client, test, and documentation changes needed for that one problem.
An adjacent cleanup, refactor, or second fix needs its own PR unless it is necessary to solve the same
problem. Explain how the pieces relate when it is not obvious; a large diff alone does not show that
the work is unrelated.

## Keep existing data working

Shared and persisted state stays compatible. That covers thread and project data, the SQLite schema,
event and outbox shapes, contracts, provider session state, and anything else an existing client or
environment reads.

- An existing database must migrate forward, never need a reset.
- An older client talking to a newer server keeps working, and the reverse.
- A change that only works on a freshly seeded environment is not ready.

Say in the PR whether existing data and mixed-version clients keep working, and how you know.

<a id="verification"></a>

## Verification

Explain how you established the problem, how you checked the change, and what you observed. Include
reproduction steps, focused test commands or manual checks, and their results. State what you could
not check. A ticked box or "tests pass" alone does not show that the change works.

Match the evidence to the change. Use focused tests for behavior that can be tested and manual
evidence where appropriate. Do not run repo-wide checks to satisfy this guide: `vp run check:changed`
covers your changed files, and CI runs the full suites.

UI changes need before/after screenshots, plus a short recording when motion, timing, or interaction
details matter. Attach evidence to the PR; do not commit PR-only screenshots or recordings.

## Titles and merging

- Use a conventional commit title in plain language, such as
  `fix(web): new threads no longer spike CPU`. PRs are squash merged, so the title becomes the commit
  message.
- Reference the issue the PR addresses in the body.
- If an agent did the work, end the PR body with the model and harness.
- CI must be green. It does not replace the behavior evidence above.
- Upstream syncs land as their own PR from a branch that carries only the upstream changes. Land local
  fixes separately so the next sync stays clean.
- Release, versioning, and publishing steps are in
  [docs/operations/release.md](docs/operations/release.md).

## Documentation

Follow the [documentation rules](AGENTS.md#documentation). Most code changes need no documentation
change. Update user guides when how to use a feature changes.
