// Protected upstream-sync designation (#50): resolves the guarded label from
// label events, timeline proof, and collaborator permissions. Never infers
// intent from title/body/branch/author or author_association; API uncertainty
// is a guard failure, never a speculative mutation. Trusted base code only.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const UPSTREAM_SYNC_LABEL = "upstream-sync";
// GitHub's official Actions bot. Trusted for this workflow's own label
// restoration/reversal events only, by login plus well-known id.
const OFFICIAL_ACTIONS_BOT = { login: "github-actions[bot]", id: 41898282 };
const AUTHORIZED_PERMISSIONS = new Set(["triage", "write", "maintain", "admin"]);
const HOTSPOT_COMMENT_MARKER = "<!-- upstream-sync-hotspot-report -->";
const DRY_RUN_WORKFLOW_FILE = "upstream-sync-dry-run.yml";
const DRY_RUN_ARTIFACT_NAME = "upstream-sync-dry-run-report";
const DRY_RUN_REPORT_FILE = "upstream-sync-report.json";
// Only the nightly schedule and manual dispatches produce trusted dry-run
// reports; a PR-triggered or fork-branch run never feeds the hotspot report.
const TRUSTED_DRY_RUN_EVENTS = new Set(["schedule", "workflow_dispatch"]);
const TIMELINE_PAGE_LIMIT = 20;
const ARTIFACT_CANDIDATE_LIMIT = 10;
const COMMENT_BODY_LIMIT = 60000;

function isOfficialActionsBot(actor) {
  return (
    actor !== null &&
    typeof actor === "object" &&
    actor.login === OFFICIAL_ACTIONS_BOT.login &&
    actor.id === OFFICIAL_ACTIONS_BOT.id &&
    actor.type === "Bot"
  );
}

// "official_bot" | "authorized_user" | "unauthorized" | "other_app" |
// "api_error" | "unknown". Permission lookups are synchronous; the caller
// prefetches them. Unknown or failed lookups are never authorized.
function actorAuthorization(actor, permissionOf) {
  if (actor === null || typeof actor !== "object" || typeof actor.login !== "string") {
    return "unknown";
  }
  if (isOfficialActionsBot(actor)) return "official_bot";
  if (typeof actor.type === "string" && actor.type !== "User") return "other_app";
  const permission = permissionOf(actor.login);
  if (permission === null || permission === undefined || permission.status !== "ok") {
    return "api_error";
  }
  return AUTHORIZED_PERMISSIONS.has(permission.permission) ? "authorized_user" : "unauthorized";
}

// The label event's sender, cross-checked with the triggering actor. Both
// sides must be authorized; an app bot passes only with user-triage proof
// (an authorized human actor behind the event).
function crossCheckedAuthorization(sender, actor, permissionOf) {
  if (isOfficialActionsBot(sender)) return "official_bot";
  const senderAuth = actorAuthorization(sender, permissionOf);
  if (senderAuth !== "authorized_user" && senderAuth !== "other_app") return senderAuth;
  const sameActor =
    actor !== null && typeof actor === "object" && sender && actor.login === sender.login;
  if (senderAuth === "other_app") {
    if (sameActor) return "other_app";
    const actorAuth = actorAuthorization(actor, permissionOf);
    if (actorAuth === "authorized_user") return "authorized_user";
    return actorAuth === "api_error" ? "api_error" : "other_app";
  }
  if (sameActor || actor === null) return "authorized_user";
  const actorAuth = actorAuthorization(actor, permissionOf);
  if (actorAuth === "authorized_user" || actorAuth === "official_bot") return "authorized_user";
  return actorAuth === "api_error" ? "api_error" : "unauthorized";
}

const isAuthorized = (auth) => auth === "official_bot" || auth === "authorized_user";

// Relevant timeline events for this label, in chronological order.
function designationEvents(events) {
  return (events ?? []).filter(
    (event) =>
      (event.event === "labeled" || event.event === "unlabeled") &&
      event.labelName === UPSTREAM_SYNC_LABEL,
  );
}

// Proof that the label's current presence traces to an authorized write:
// the latest relevant event is a labeled event by an authorized user or the
// official reconciliation bot. Returns an authorization-style string.
function timelineProof(relevant, permissionOf) {
  const last = relevant[relevant.length - 1];
  if (last === undefined) return "missing";
  if (last.event !== "labeled") return "contradictory";
  const auth = actorAuthorization(last.actor, permissionOf);
  if (auth === "api_error") return "api_error";
  if (auth === "official_bot" || auth === "authorized_user") return "proven";
  return "contradictory";
}

// Resolve one event into designated / not_designated / invalid plus the
// reconciliation mutation. Pure and synchronous: permissionOf and getTimeline
// are supplied by the caller. Uncertainty is never resolved speculatively:
// API failures yield invalid with mutation "none" (guard failure).
function resolveUpstreamSyncDesignation({
  kind,
  hasLabel,
  sender,
  actor,
  permissionOf,
  getTimeline,
}) {
  const invalid = (mutation, reason) => ({ designation: "invalid", mutation, reason });
  const notDesignated = (reason) => ({ designation: "not_designated", mutation: "none", reason });
  const designated = (reason) => ({ designation: "designated", mutation: "none", reason });

  if (kind === "observed" && !hasLabel) {
    return notDesignated("no upstream-sync label; no timeline lookup");
  }

  const auth =
    kind === "observed" ? "unknown" : crossCheckedAuthorization(sender, actor, permissionOf);

  if (kind === "labeled") {
    if (isAuthorized(auth)) return designated("authorized label addition");
    if (auth === "api_error" || auth === "unknown") {
      return invalid("none", "authorization could not be verified; no speculative mutation");
    }
    return invalid("remove", "unauthorized label addition; reversing");
  }

  if (kind === "unlabeled") {
    if (isAuthorized(auth)) return notDesignated("authorized removal");
    if (auth === "api_error" || auth === "unknown") {
      return invalid(
        "none",
        "remover authorization could not be verified; no speculative mutation",
      );
    }
    const timeline = getTimeline();
    if (!timeline || timeline.status !== "ok") {
      return invalid("none", "timeline unverifiable after an unauthorized removal; guard failure");
    }
    const relevant = designationEvents(timeline.events);
    // Drop the trailing removal(s): the current event may already be listed.
    while (relevant.length > 0 && relevant[relevant.length - 1].event === "unlabeled") {
      relevant.pop();
    }
    const last = relevant[relevant.length - 1];
    if (last === undefined || last.event !== "labeled") {
      return notDesignated("removed label was never provably designated");
    }
    const priorAuth = actorAuthorization(last.actor, permissionOf);
    if (priorAuth === "api_error") {
      return invalid("none", "prior designation actor unverifiable; no speculative mutation");
    }
    if (priorAuth === "official_bot" || priorAuth === "authorized_user") {
      return {
        designation: "designated",
        mutation: "restore",
        reason: "unauthorized removal of a provable designation; restoring",
      };
    }
    return notDesignated("removed label was not a proven designation");
  }

  // observed (opened/reopened/synchronize) with the label present.
  const timeline = getTimeline();
  if (!timeline || timeline.status !== "ok") {
    return invalid("none", "timeline unverifiable; guard failure");
  }
  const proof = timelineProof(designationEvents(timeline.events), permissionOf);
  if (proof === "proven") return designated("timeline proves an authorized designation");
  if (proof === "api_error") {
    return invalid("none", "timeline actor unverifiable; no speculative mutation");
  }
  if (proof === "missing") {
    return invalid("remove", "label has no provenance (missing timeline proof); removing");
  }
  return invalid("remove", "latest designation event is contradictory; removing");
}

// Re-reads the current labels immediately before mutating and aborts when the
// state moved since resolution, so concurrent events never double-write.
async function reconcileUpstreamSyncDesignation({
  resolution,
  expectedHasLabel,
  readLabels,
  addLabel,
  removeLabel,
}) {
  if (resolution.mutation === "none") {
    return { action: "none", reason: resolution.reason };
  }
  const current = await readLabels();
  const currentHas = current.includes(UPSTREAM_SYNC_LABEL);
  if (currentHas !== expectedHasLabel) {
    return {
      action: "aborted",
      reason: `labels changed since resolution (expected the label ${
        expectedHasLabel ? "present" : "absent"
      })`,
    };
  }
  if (resolution.mutation === "remove" && currentHas) {
    await removeLabel();
    return { action: "removed", reason: resolution.reason };
  }
  if (resolution.mutation === "restore" && !currentHas) {
    await addLabel();
    return { action: "added", reason: resolution.reason };
  }
  return { action: "none", reason: "already reconciled" };
}

// The CI claim: the current PR carries the label, or the event is the
// addition/removal of it. No claim means the resolver is never consulted.
function hasUpstreamSyncClaim(eventName, payload) {
  if (eventName !== "pull_request" || payload === null || typeof payload !== "object") return false;
  const pullRequest = payload.pull_request;
  if (pullRequest === null || typeof pullRequest !== "object") return false;
  const labels = Array.isArray(pullRequest.labels)
    ? pullRequest.labels.map((label) => label?.name)
    : [];
  if (labels.includes(UPSTREAM_SYNC_LABEL)) return true;
  const action = payload.action;
  return (
    (action === "labeled" || action === "unlabeled") && payload.label?.name === UPSTREAM_SYNC_LABEL
  );
}

// Trusted-provenance dry-run workflow runs, newest first.
function rankDryRunArtifactRuns(runs, { defaultBranch }) {
  return (runs ?? [])
    .filter(
      (entry) =>
        entry &&
        entry.status === "completed" &&
        entry.head_branch === defaultBranch &&
        TRUSTED_DRY_RUN_EVENTS.has(entry.event),
    )
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

// Newest report whose tag/base/upstream match the real merge wins.
function selectMatchingReport(candidates, expected) {
  return (candidates ?? []).find(
    (candidate) =>
      candidate?.report &&
      candidate.report.tag === expected.tag &&
      candidate.report.baseSha === expected.baseSha &&
      candidate.report.upstreamSha === expected.upstreamSha,
  );
}

function findHotspotComment(comments, marker = HOTSPOT_COMMENT_MARKER) {
  return (comments ?? []).find(
    (comment) => typeof comment?.body === "string" && comment.body.includes(marker),
  );
}

function planCommentUpsert(existing) {
  return existing === undefined ? { method: "post" } : { method: "patch", commentId: existing.id };
}

// Workflow drivers. Every lookup failure on a claimed PR fails closed to
// "invalid"; unclaimed events never touch the network.

function readApiEnv() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repo slug.");
  }
  if (token === "") throw new Error("GITHUB_TOKEN is required.");
  return {
    repository,
    token,
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
  };
}

async function githubFetch(env, urlPath, init = {}) {
  return fetch(`${env.apiUrl}${urlPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "upstream-sync-pr",
      ...init.headers,
    },
  });
}

async function githubJson(env, urlPath, init = {}) {
  const response = await githubFetch(env, urlPath, init);
  if (!response.ok) {
    const error = new Error(`GET ${urlPath} failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchPermission(env, login) {
  try {
    const data = await githubJson(
      env,
      `/repos/${env.repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return { status: "ok", permission: data?.permission ?? "none" };
  } catch (error) {
    if (error.status === 404) return { status: "ok", permission: "none" };
    return { status: "error" };
  }
}

async function fetchUserInfo(env, login) {
  const data = await githubJson(env, `/users/${encodeURIComponent(login)}`);
  return { login: data.login, type: data.type, id: data.id };
}

// Paginated timeline of label events, chronological. Any failure poisons the
// whole lookup so resolution can refuse to mutate speculatively.
async function fetchTimeline(env, number) {
  const events = [];
  try {
    for (let page = 1; page <= TIMELINE_PAGE_LIMIT; page++) {
      const data = await githubJson(
        env,
        `/repos/${env.repository}/issues/${number}/events?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data)) return { status: "error" };
      for (const entry of data) {
        if (entry.event !== "labeled" && entry.event !== "unlabeled") continue;
        events.push({
          event: entry.event,
          labelName: entry.label?.name,
          actor: entry.actor
            ? { login: entry.actor.login, type: entry.actor.type, id: entry.actor.id }
            : null,
        });
      }
      if (data.length < 100) return { status: "ok", events };
    }
  } catch {
    return { status: "error" };
  }
  // More pages than the limit: unverifiable rather than partial.
  return { status: "error" };
}

// Prefetches every permission the pure resolver could ask for, then resolves.
async function resolveWithLookups(env, { kind, number, sender, actorLogin, hasLabel }) {
  const permissions = new Map();
  const permissionOf = (login) => permissions.get(login) ?? { status: "error" };

  let actor = null;
  if (actorLogin !== null && actorLogin !== undefined) {
    if (sender && actorLogin === sender.login) {
      actor = sender;
    } else {
      try {
        actor = await fetchUserInfo(env, actorLogin);
      } catch {
        actor = { login: actorLogin, type: "unknown-user", id: -1 };
      }
    }
  }

  const needsTimeline = kind === "unlabeled" || (kind === "observed" && hasLabel);
  let timeline = null;
  if (needsTimeline) timeline = await fetchTimeline(env, number);

  const logins = new Set();
  for (const candidate of [sender, actor]) {
    if (candidate && typeof candidate.login === "string" && candidate.type === "User") {
      logins.add(candidate.login);
    }
  }
  if (timeline && timeline.status === "ok") {
    for (const event of timeline.events) {
      if (event.actor && event.actor.type === "User") logins.add(event.actor.login);
    }
  }
  await Promise.all(
    [...logins].map(async (login) => {
      permissions.set(login, await fetchPermission(env, login));
    }),
  );

  return resolveUpstreamSyncDesignation({
    kind,
    hasLabel,
    sender,
    actor,
    permissionOf,
    getTimeline: () => timeline ?? { status: "error" },
  });
}

async function readCurrentLabels(env, number) {
  const data = await githubJson(
    env,
    `/repos/${env.repository}/issues/${number}/labels?per_page=100`,
  );
  return data.map((label) => label.name);
}

function eventContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const payload = eventPath === "" ? {} : JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const number = payload?.issue?.number ?? payload?.pull_request?.number ?? null;
  const action = payload?.action ?? null;
  const kind = action === "labeled" ? "labeled" : action === "unlabeled" ? "unlabeled" : "observed";
  return { eventName, payload, number, action, kind };
}

// CI detection mode: prints exactly one `sync=` line for the ci-changes action.
async function resolveCiDesignation() {
  const { eventName, payload } = eventContext();
  if (!hasUpstreamSyncClaim(eventName, payload)) return "none";
  try {
    const env = readApiEnv();
    const number = payload.pull_request.number;
    const hasLabel = await readCurrentLabels(env, number).then((labels) =>
      labels.includes(UPSTREAM_SYNC_LABEL),
    );
    const { kind } = eventContext();
    const resolution = await resolveWithLookups(env, {
      kind,
      number,
      sender: payload.sender ?? null,
      actorLogin: process.env.GITHUB_ACTOR ?? null,
      hasLabel,
    });
    if (resolution.designation === "designated") return "designated";
    if (resolution.designation === "invalid") return "invalid";
    return "none";
  } catch {
    // A claimed PR whose resolution failed can only add work or fail Check.
    return "invalid";
  }
}

// Reconciliation mode for upstream-sync-pr.yml (issues and pull_request_target).
async function reconcileMode() {
  const env = readApiEnv();
  const { eventName, payload, number, action, kind } = eventContext();
  if (number === null) throw new Error("The event payload carries no issue or PR number.");
  if ((kind === "labeled" || kind === "unlabeled") && payload.label?.name !== UPSTREAM_SYNC_LABEL) {
    console.log(`Ignoring ${action} of ${JSON.stringify(payload.label?.name)}.`);
    return;
  }
  const hasLabel = (await readCurrentLabels(env, number)).includes(UPSTREAM_SYNC_LABEL);
  if (kind === "observed" && eventName === "issues") {
    console.log("Issue events reconcile on label changes only.");
    return;
  }
  const resolution = await resolveWithLookups(env, {
    kind,
    number,
    sender: payload.sender ?? null,
    actorLogin: process.env.GITHUB_ACTOR ?? null,
    hasLabel,
  });
  console.log(
    `${eventName}#${number} ${action}: ${resolution.designation} (${resolution.mutation}): ${resolution.reason}`,
  );

  if (resolution.mutation !== "none") {
    const result = await reconcileUpstreamSyncDesignation({
      resolution,
      expectedHasLabel: hasLabel,
      readLabels: () => readCurrentLabels(env, number),
      addLabel: async () => {
        const response = await githubFetch(
          env,
          `/repos/${env.repository}/issues/${number}/labels`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ labels: [UPSTREAM_SYNC_LABEL] }),
          },
        );
        if (!response.ok) throw new Error(`Adding the label failed: ${response.status}`);
      },
      removeLabel: async () => {
        const response = await githubFetch(
          env,
          `/repos/${env.repository}/issues/${number}/labels/${encodeURIComponent(UPSTREAM_SYNC_LABEL)}`,
          { method: "DELETE" },
        );
        if (!response.ok && response.status !== 404) {
          throw new Error(`Removing the label failed: ${response.status}`);
        }
      },
    });
    console.log(`reconciliation: ${result.action} (${result.reason})`);
    return;
  }
  if (resolution.designation === "invalid") {
    // Guard failure: the claim could not be verified either way. CI's own
    // resolution fails Check; this job fails so the state is visible.
    process.exitCode = 1;
  }
}

// Report-job mode: prints designation=/mutation= lines for step gating.
async function resolvePrMode(args) {
  const env = readApiEnv();
  const number = requiredNumberArg(args, "--number") ?? eventContext().number;
  if (number === null) throw new Error("Missing --number and no event payload number.");
  const { kind } = eventContext();
  const hasLabel = (await readCurrentLabels(env, number)).includes(UPSTREAM_SYNC_LABEL);
  const resolution = await resolveWithLookups(env, {
    kind: eventContext().action === null ? "observed" : kind,
    number,
    sender: eventContext().payload.sender ?? null,
    actorLogin: process.env.GITHUB_ACTOR ?? null,
    hasLabel,
  });
  console.log(`designation=${resolution.designation}`);
  console.log(`mutation=${resolution.mutation}`);
  console.error(`resolve-pr #${number}: ${resolution.designation}: ${resolution.reason}`);
}

function requiredNumberArg(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${flag} must be a positive integer.`);
  return value;
}

function requiredArg(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) throw new Error(`Missing required argument ${flag}.`);
  return args[index + 1];
}

// Selects the newest trusted-provenance dry-run artifact whose report matches
// the real merge identity. Prints found=/artifact_id=/run_url= lines.
async function selectArtifactMode(args) {
  const env = readApiEnv();
  const defaultBranch = process.env.DEFAULT_BRANCH ?? "";
  if (defaultBranch === "") throw new Error("DEFAULT_BRANCH is required.");
  const expected = {
    tag: requiredArg(args, "--expect-tag"),
    baseSha: requiredArg(args, "--expect-base-sha"),
    upstreamSha: requiredArg(args, "--expect-upstream-sha"),
  };
  const data = await githubJson(
    env,
    `/repos/${env.repository}/actions/workflows/${DRY_RUN_WORKFLOW_FILE}/runs?per_page=50`,
  );
  const ranked = rankDryRunArtifactRuns(data.workflow_runs ?? [], { defaultBranch });
  const candidates = [];
  for (const runEntry of ranked.slice(0, ARTIFACT_CANDIDATE_LIMIT)) {
    const artifacts = await githubJson(
      env,
      `/repos/${env.repository}/actions/runs/${runEntry.id}/artifacts?per_page=100`,
    );
    const artifact = (artifacts.artifacts ?? []).find(
      (entry) => entry.name === DRY_RUN_ARTIFACT_NAME,
    );
    if (artifact === undefined) continue;
    const report = await downloadDryRunReport(env, artifact.id);
    if (report === undefined) continue;
    candidates.push({ run: runEntry, artifact, report });
  }
  const match = selectMatchingReport(candidates, expected);
  if (match === undefined) {
    console.log("found=false");
    console.error(
      `No completed default-branch dry-run artifact matches tag ${expected.tag}, base ${expected.baseSha}, upstream ${expected.upstreamSha}.`,
    );
    return;
  }
  console.log("found=true");
  console.log(`artifact_id=${match.artifact.id}`);
  console.log(`run_url=${match.run.html_url}`);
  console.log(`run_id=${match.run.id}`);
}

async function downloadDryRunReport(env, artifactId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-artifact-"));
  const zipPath = path.join(dir, "artifact.zip");
  try {
    const response = await githubFetch(
      env,
      `/repos/${env.repository}/actions/artifacts/${artifactId}/zip`,
    );
    if (!response.ok) return undefined;
    fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const reportPath = path.join(dir, DRY_RUN_REPORT_FILE);
    if (!fs.existsSync(reportPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function listComments(env, number) {
  const comments = [];
  for (let page = 1; page <= TIMELINE_PAGE_LIMIT; page++) {
    const data = await githubJson(
      env,
      `/repos/${env.repository}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    comments.push(...data);
    if (data.length < 100) return comments;
  }
  return comments;
}

// Upserts the single bot hotspot comment; never edits the PR body.
async function upsertCommentMode(args) {
  const env = readApiEnv();
  const number = requiredNumberArg(args, "--number");
  let body = fs.readFileSync(requiredArg(args, "--body-file"), "utf8");
  if (!body.includes(HOTSPOT_COMMENT_MARKER)) {
    body = `${HOTSPOT_COMMENT_MARKER}\n${body}`;
  }
  if (body.length > COMMENT_BODY_LIMIT) {
    body = `${body.slice(0, COMMENT_BODY_LIMIT)}\n\n(report truncated to the comment limit)\n`;
  }
  const existing = findHotspotComment(await listComments(env, number));
  const plan = planCommentUpsert(existing);
  const response =
    plan.method === "patch"
      ? await githubFetch(env, `/repos/${env.repository}/issues/comments/${plan.commentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        })
      : await githubFetch(env, `/repos/${env.repository}/issues/${number}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
  if (!response.ok) throw new Error(`Comment ${plan.method} failed: ${response.status}`);
  console.log(`Hotspot report comment ${plan.method}ed on #${number}.`);
}

// An authorized designation removal deletes the report with the label.
async function deleteCommentMode(args) {
  const env = readApiEnv();
  const number = requiredNumberArg(args, "--number");
  const existing = findHotspotComment(await listComments(env, number));
  if (existing === undefined) {
    console.log(`No hotspot report comment on #${number}.`);
    return;
  }
  const response = await githubFetch(
    env,
    `/repos/${env.repository}/issues/comments/${existing.id}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Deleting the comment failed: ${response.status}`);
  }
  console.log(`Deleted the hotspot report comment on #${number}.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--resolve-ci-designation")) {
    console.log(`sync=${await resolveCiDesignation()}`);
    return;
  }
  const mode = args[0];
  switch (mode) {
    case "reconcile":
      return reconcileMode();
    case "resolve-pr":
      return resolvePrMode(args);
    case "select-artifact":
      return selectArtifactMode(args);
    case "upsert-comment":
      return upsertCommentMode(args);
    case "delete-comment":
      return deleteCommentMode(args);
    default:
      throw new Error(
        `Unknown mode ${JSON.stringify(mode)}. Expected reconcile, resolve-pr, select-artifact, upsert-comment, or delete-comment.`,
      );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  AUTHORIZED_PERMISSIONS,
  DRY_RUN_ARTIFACT_NAME,
  HOTSPOT_COMMENT_MARKER,
  OFFICIAL_ACTIONS_BOT,
  UPSTREAM_SYNC_LABEL,
  actorAuthorization,
  findHotspotComment,
  hasUpstreamSyncClaim,
  isOfficialActionsBot,
  planCommentUpsert,
  rankDryRunArtifactRuns,
  reconcileUpstreamSyncDesignation,
  resolveUpstreamSyncDesignation,
  selectMatchingReport,
};
