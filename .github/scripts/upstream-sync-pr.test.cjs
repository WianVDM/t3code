// Protected upstream-sync designation (#50): authorization, provenance, and
// reconciliation policy, plus the trusted wiring of upstream-sync-pr.yml.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  AUTHORIZED_PERMISSIONS,
  HOTSPOT_COMMENT_MARKER,
  OFFICIAL_ACTIONS_BOT,
  UPSTREAM_SYNC_LABEL,
  findHotspotComment,
  hasUpstreamSyncClaim,
  isOfficialActionsBot,
  planCommentUpsert,
  rankDryRunArtifactRuns,
  reconcileUpstreamSyncDesignation,
  resolveUpstreamSyncDesignation,
  selectMatchingReport,
} = require("./upstream-sync-pr.cjs");

const repoRoot = path.resolve(__dirname, "../..");

const user = (login, id = 1000) => ({ login, type: "User", id });
const bot = (login, id) => ({ login, type: "Bot", id });
const officialBot = () => ({ ...OFFICIAL_ACTIONS_BOT, type: "Bot" });
const otherApp = () => bot("some-other-app[bot]", 999999);

// permissionOf doubles: a map of login -> permission result.
const perms = (map) => (login) =>
  Object.prototype.hasOwnProperty.call(map, login) ? map[login] : { status: "error" };
const ok = (permission) => ({ status: "ok", permission });
const apiError = () => ({ status: "error" });

const labeledEvent = (actor) => ({ event: "labeled", labelName: UPSTREAM_SYNC_LABEL, actor });
const unlabeledEvent = (actor) => ({ event: "unlabeled", labelName: UPSTREAM_SYNC_LABEL, actor });
const otherLabelEvent = (actor) => ({ event: "labeled", labelName: "bug", actor });
const timelineOk = (events) => () => ({ status: "ok", events });
const timelineError = () => ({ status: "error" });
const noTimeline = () => {
  throw new Error("timeline must not be consulted");
};

function resolve(input) {
  return resolveUpstreamSyncDesignation({
    kind: "observed",
    hasLabel: false,
    sender: null,
    actor: null,
    permissionOf: perms({}),
    getTimeline: noTimeline,
    ...input,
  });
}

test("the official reconciliation bot identity is the well-known login and id", () => {
  assert.equal(OFFICIAL_ACTIONS_BOT.login, "github-actions[bot]");
  assert.equal(OFFICIAL_ACTIONS_BOT.id, 41898282);
  assert.ok(isOfficialActionsBot(officialBot()));
  // Login alone or id alone never proves the identity.
  assert.ok(!isOfficialActionsBot(bot("github-actions[bot]", 1)));
  assert.ok(!isOfficialActionsBot(bot("other[bot]", 41898282)));
  assert.ok(!isOfficialActionsBot(bot("github-actions", 41898282)));
  assert.ok(!isOfficialActionsBot(null));
});

test("authorized permissions are exactly triage and above", () => {
  assert.deepEqual([...AUTHORIZED_PERMISSIONS].sort(), ["admin", "maintain", "triage", "write"]);
});

// Authorization: label events resolve through the sender's repository
// permission, cross-checked with the triggering actor. read/none/unknown and
// API failures are rejected; author_association proves nothing.
for (const permission of ["triage", "write", "maintain", "admin"]) {
  test(`a ${permission} user may apply the designation`, () => {
    const result = resolve({
      kind: "labeled",
      hasLabel: true,
      sender: user("maint"),
      actor: user("maint"),
      permissionOf: perms({ maint: ok(permission) }),
    });
    assert.equal(result.designation, "designated");
    assert.equal(result.mutation, "none");
  });
}

for (const permission of ["read", "none", "unknown"]) {
  test(`a ${permission} user cannot apply the designation`, () => {
    const result = resolve({
      kind: "labeled",
      hasLabel: true,
      sender: user("rando"),
      actor: user("rando"),
      permissionOf: perms({ rando: ok(permission) }),
    });
    assert.equal(result.designation, "invalid");
    assert.equal(result.mutation, "remove");
  });
}

test("an API failure while checking the sender is a guard failure, not a mutation", () => {
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender: user("maint"),
    actor: user("maint"),
    permissionOf: perms({ maint: apiError() }),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "none");
});

test("metadata cannot spoof authorization: author_association is never consulted", () => {
  const sender = { ...user("author"), author_association: "OWNER" };
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender,
    actor: sender,
    permissionOf: perms({ author: ok("read") }),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
});

test("a sender whose triggering actor is unauthorized is rejected", () => {
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender: user("maint"),
    actor: user("rando"),
    permissionOf: perms({ maint: ok("admin"), rando: ok("read") }),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
});

// Trusted automation amendment: the reconciliation workflow's own writes come
// from GitHub's official github-actions[bot]; other apps are invalid without a
// user-triage proof, and write-capable apps are never trusted by capability.
test("the official Actions bot's own label write is accepted", () => {
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender: officialBot(),
    actor: officialBot(),
    permissionOf: perms({}),
  });
  assert.equal(result.designation, "designated");
  assert.equal(result.mutation, "none");
});

test("another app bot is rejected even though it could write labels", () => {
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender: otherApp(),
    actor: otherApp(),
    permissionOf: perms({}),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
});

test("an app bot with an authorized user actor carries user-triage proof", () => {
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender: otherApp(),
    actor: user("maint"),
    permissionOf: perms({ maint: ok("maintain") }),
  });
  assert.equal(result.designation, "designated");
});

test("an app bot without user-triage proof stays invalid", () => {
  const result = resolve({
    kind: "labeled",
    hasLabel: true,
    sender: otherApp(),
    actor: user("rando"),
    permissionOf: perms({ rando: ok("read") }),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
});

// Removals: an authorized removal stands; an unauthorized removal restores
// only a previously provable designation.
test("an authorized removal accepts not_designated", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: user("maint"),
    actor: user("maint"),
    permissionOf: perms({ maint: ok("admin") }),
    getTimeline: noTimeline,
  });
  assert.equal(result.designation, "not_designated");
  assert.equal(result.mutation, "none");
});

test("the official bot's reversal of an unauthorized addition stands", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: officialBot(),
    actor: officialBot(),
    permissionOf: perms({}),
    getTimeline: noTimeline,
  });
  assert.equal(result.designation, "not_designated");
  assert.equal(result.mutation, "none");
});

test("an unauthorized removal restores a previously provable designation", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: user("rando"),
    actor: user("rando"),
    permissionOf: perms({ rando: ok("read"), maint: ok("write") }),
    getTimeline: timelineOk([labeledEvent(user("maint")), unlabeledEvent(user("rando"))]),
  });
  assert.equal(result.designation, "designated");
  assert.equal(result.mutation, "restore");
});

test("an unauthorized removal of an unproven addition stays removed", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: user("rando"),
    actor: user("rando"),
    permissionOf: perms({ rando: ok("read"), sneaky: ok("read") }),
    getTimeline: timelineOk([labeledEvent(user("sneaky")), unlabeledEvent(user("rando"))]),
  });
  assert.equal(result.designation, "not_designated");
  assert.equal(result.mutation, "none");
});

test("an unauthorized removal with no provable history stays removed", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: user("rando"),
    actor: user("rando"),
    permissionOf: perms({ rando: ok("read") }),
    getTimeline: timelineOk([unlabeledEvent(user("rando"))]),
  });
  assert.equal(result.designation, "not_designated");
  assert.equal(result.mutation, "none");
});

test("an unauthorized removal with an unverifiable timeline is a guard failure", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: user("rando"),
    actor: user("rando"),
    permissionOf: perms({ rando: ok("read") }),
    getTimeline: timelineError,
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "none");
});

test("a historical actor whose permission lookup fails is a guard failure", () => {
  const result = resolve({
    kind: "unlabeled",
    hasLabel: false,
    sender: user("rando"),
    actor: user("rando"),
    permissionOf: perms({ rando: ok("read"), maint: apiError() }),
    getTimeline: timelineOk([labeledEvent(user("maint")), unlabeledEvent(user("rando"))]),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "none");
});

// Observed events (opened/reopened/synchronize) with the label present need
// paginated timeline proof of the latest relevant labeled event.
test("an ordinary PR without the label never looks at the timeline", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: false,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({}),
    getTimeline: noTimeline,
  });
  assert.equal(result.designation, "not_designated");
  assert.equal(result.mutation, "none");
});

test("an opened issue-form label with no timeline proof is reversed", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: true,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({}),
    getTimeline: timelineOk([otherLabelEvent(user("author"))]),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
  assert.match(result.reason, /no provenance|not provable|missing/i);
});

test("an existing authorized timeline is retained on synchronize", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: true,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({ maint: ok("triage") }),
    getTimeline: timelineOk([labeledEvent(user("maint"))]),
  });
  assert.equal(result.designation, "designated");
  assert.equal(result.mutation, "none");
});

test("the official reconciliation bot's restoration survives later synchronize events", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: true,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({ rando: ok("read") }),
    getTimeline: timelineOk([
      labeledEvent(user("rando")),
      unlabeledEvent(officialBot()),
      labeledEvent(officialBot()),
    ]),
  });
  assert.equal(result.designation, "designated");
});

test("a contradictory history (latest labeled event unauthorized) is invalid", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: true,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({ maint: ok("admin"), rando: ok("none") }),
    getTimeline: timelineOk([labeledEvent(user("maint")), labeledEvent(user("rando"))]),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
});

test("an unverifiable timeline on an observed event is a guard failure", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: true,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({}),
    getTimeline: timelineError,
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "none");
});

test("an app-bot labeled event in the timeline is not proof", () => {
  const result = resolve({
    kind: "observed",
    hasLabel: true,
    sender: user("author"),
    actor: user("author"),
    permissionOf: perms({}),
    getTimeline: timelineOk([labeledEvent(otherApp())]),
  });
  assert.equal(result.designation, "invalid");
  assert.equal(result.mutation, "remove");
});

// Reconciliation is race-safe: labels are re-read immediately before the
// mutation, and a changed state aborts without writing.
test("reconcile removes an unproven addition and adds a proven restoration", async () => {
  const calls = [];
  const removed = await reconcileUpstreamSyncDesignation({
    resolution: { designation: "invalid", mutation: "remove", reason: "unproven" },
    expectedHasLabel: true,
    readLabels: async () => [UPSTREAM_SYNC_LABEL, "bug"],
    addLabel: async () => calls.push("add"),
    removeLabel: async () => calls.push("remove"),
  });
  assert.equal(removed.action, "removed");
  assert.deepEqual(calls, ["remove"]);

  calls.length = 0;
  const restored = await reconcileUpstreamSyncDesignation({
    resolution: { designation: "designated", mutation: "restore", reason: "proven" },
    expectedHasLabel: false,
    readLabels: async () => ["bug"],
    addLabel: async () => calls.push("add"),
    removeLabel: async () => calls.push("remove"),
  });
  assert.equal(restored.action, "added");
  assert.deepEqual(calls, ["add"]);
});

test("reconcile aborts without writing when the labels changed since resolution", async () => {
  const calls = [];
  const result = await reconcileUpstreamSyncDesignation({
    resolution: { designation: "invalid", mutation: "remove", reason: "unproven" },
    expectedHasLabel: true,
    readLabels: async () => ["bug"],
    addLabel: async () => calls.push("add"),
    removeLabel: async () => calls.push("remove"),
  });
  assert.equal(result.action, "aborted");
  assert.deepEqual(calls, []);
});

test("reconcile never mutates for mutation none", async () => {
  const calls = [];
  const result = await reconcileUpstreamSyncDesignation({
    resolution: { designation: "designated", mutation: "none", reason: "authorized" },
    expectedHasLabel: true,
    readLabels: async () => {
      calls.push("read");
      return [UPSTREAM_SYNC_LABEL];
    },
    addLabel: async () => calls.push("add"),
    removeLabel: async () => calls.push("remove"),
  });
  assert.equal(result.action, "none");
  assert.deepEqual(calls, []);
});

// The CI claim: the current PR carries the label, or the event is the
// addition/removal of it. Nothing else ever touches the resolver.
const prPayload = (action, labels, labelName) => ({
  action,
  label: labelName === undefined ? undefined : { name: labelName },
  pull_request: { number: 7, labels: labels.map((name) => ({ name })) },
});

test("hasUpstreamSyncClaim covers label presence and label events only", () => {
  assert.ok(hasUpstreamSyncClaim("pull_request", prPayload("synchronize", [UPSTREAM_SYNC_LABEL])));
  assert.ok(
    hasUpstreamSyncClaim("pull_request", prPayload("labeled", [], UPSTREAM_SYNC_LABEL)),
    "addition claims",
  );
  assert.ok(
    hasUpstreamSyncClaim("pull_request", prPayload("unlabeled", [], UPSTREAM_SYNC_LABEL)),
    "removal claims",
  );
  assert.ok(!hasUpstreamSyncClaim("pull_request", prPayload("synchronize", ["bug"])));
  assert.ok(!hasUpstreamSyncClaim("pull_request", prPayload("labeled", [], "bug")));
  assert.ok(!hasUpstreamSyncClaim("push", {}));
  assert.ok(!hasUpstreamSyncClaim("pull_request", {}));
});

// Artifact provenance: only completed default-branch dry runs triggered by the
// schedule or a manual dispatch count, newest first.
const run = (overrides) => ({
  id: 1,
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  event: "schedule",
  created_at: "2025-01-01T00:00:00Z",
  html_url: "https://example/runs/1",
  ...overrides,
});

test("rankDryRunArtifactRuns keeps only trusted provenance, newest first", () => {
  const ranked = rankDryRunArtifactRuns(
    [
      run({ id: 1, created_at: "2025-01-01T00:00:00Z" }),
      run({ id: 2, status: "in_progress" }),
      run({ id: 3, head_branch: "feature" }),
      run({ id: 4, event: "pull_request" }),
      run({ id: 5, event: "workflow_dispatch", created_at: "2025-03-01T00:00:00Z" }),
      run({ id: 6, event: "repository_dispatch" }),
      run({ id: 7, created_at: "2025-02-01T00:00:00Z" }),
    ],
    { defaultBranch: "main" },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.id),
    [5, 7, 1],
  );
});

test("selectMatchingReport picks the newest report matching the real merge", () => {
  const expected = { tag: "v1.2.3", baseSha: "b".repeat(40), upstreamSha: "u".repeat(40) };
  const candidates = [
    { run: run({ id: 9 }), report: { ...expected, tag: "v9.9.9" } },
    { run: run({ id: 8 }), report: { ...expected } },
    { run: run({ id: 7 }), report: { ...expected } },
  ];
  assert.equal(selectMatchingReport(candidates, expected).run.id, 8);
  assert.equal(
    selectMatchingReport(
      [{ run: run({ id: 9 }), report: { ...expected, tag: "v9.9.9" } }],
      expected,
    ),
    undefined,
  );
});

// One bot comment, found by its marker; the PR body is never edited.
test("findHotspotComment and planCommentUpsert upsert exactly one comment", () => {
  const comments = [
    { id: 1, body: "unrelated" },
    { id: 2, body: `text\n${HOTSPOT_COMMENT_MARKER}\nreport` },
  ];
  const found = findHotspotComment(comments);
  assert.equal(found.id, 2);
  assert.deepEqual(planCommentUpsert(found), { method: "patch", commentId: 2 });
  assert.deepEqual(planCommentUpsert(undefined), { method: "post" });
  assert.equal(findHotspotComment([]), undefined);
});

// Workflow safety: the reconciliation and reporting jobs run trusted base code
// only, treat the PR head as passive data, and hold minimal permissions.
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/upstream-sync-pr.yml"),
  "utf8",
);

test("the sync PR workflow is trusted-base only with minimal permissions", () => {
  // Every checkout is plain git (actions/checkout's credential cleanup fails on
  // the orphaned .repos gitlinks) and pins a trusted ref: the base SHA for PR
  // events, the triggering default-branch SHA for issues. Never the head.
  assert.ok(!/uses: actions\/checkout/.test(workflow), "use plain git, not actions/checkout");
  const checkouts = (workflow.match(/^ {10}git init \.$/gm) ?? []).length;
  assert.ok(checkouts >= 2, "reconcile and report each check out");
  assert.ok(
    !/(ref|CHECKOUT_REF):.*head\.(sha|ref)/.test(workflow),
    "no checkout may use the PR head ref or sha",
  );
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  // No secrets, no write to contents, no execution of head code.
  assert.ok(!/secrets:/.test(workflow), "the workflow must not reference secrets");
  assert.ok(!/contents: write/.test(workflow));
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /pull-requests: write/);
  // Mutations serialize and are never cancelled mid-flight.
  assert.match(workflow, /cancel-in-progress: false/);
  // The report job never installs before it knows the designation, and the
  // trusted base is checked out before any install step.
  const report = workflow.slice(workflow.indexOf("\n  report:\n"));
  assert.ok(
    report.indexOf("actions/checkout@v6") < report.indexOf("setup-ci-deps"),
    "the report job must check out the trusted base before installing",
  );
  assert.match(report, /resolve-pr/);
  // The head is revalidated immediately before publishing.
  assert.ok(
    report.indexOf("Revalidate the head") < report.indexOf("upsert-comment"),
    "the head must be revalidated after generation and before publishing",
  );
  assert.match(report, /refs\/pull\/\$\{PR_NUMBER\}\/head/);
  // An authorized removal deletes the report.
  assert.match(report, /delete-comment/);
  assert.match(report, /not_designated/);
});

test("the reconciliation job filters to upstream-sync label events and claimed PRs", () => {
  assert.match(workflow, /github\.event\.label\.name == 'upstream-sync'/);
  assert.match(
    workflow,
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'upstream-sync'\)/,
  );
  const reconcile = workflow.slice(
    workflow.indexOf("\n  reconcile:\n"),
    workflow.indexOf("\n  report:\n"),
  );
  assert.match(reconcile, /issues: write/);
  assert.match(reconcile, /upstream-sync-pr\.cjs reconcile/);
});
