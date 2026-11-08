// Metadata-only PR-to-issue traceability check (#43): a PR passes when its body
// links a same-repository issue carrying the `accepted` label via "Closes #<n>"
// or "Part of #<n>" and every reference is valid. Advisory until B12 sets the
// ISSUE_TRACEABILITY_ENFORCED repository variable; see issue-traceability.yml.
const fs = require("node:fs");

const REQUIRED_LABEL = "accepted";
const SUPPORTED_ACTIONS = ["opened", "edited", "reopened", "synchronize", "ready_for_review"];

// GitHub's closing keywords plus the explicit "Part of" step-of-work marker.
// A keyword only counts when the next token looks like a reference attempt, so
// prose such as "this closes the gap" is ignored.
const KEYWORD_PATTERN =
  /\b(closes?|closed|fixes?|fixed|resolves?|resolved|part\s+of)[ \t\n]+(\S+)/giu;
const SAME_REPO_REFERENCE_PATTERN = /^#(\d+)(?!\w)/u;
const CROSS_REFERENCE_PATTERN = /^([\w.-]+)\/([\w.-]+)#(\d+)(?!\w)/u;
const GITHUB_URL_PATTERN =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)(?!\w)/iu;

// GitHub renders comments and code inert, so closing keywords there never act;
// the parser must not see them either.
function stripInertContent(body) {
  return body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/gu, "")
    .replace(/`[^`\n]*`/gu, "");
}

function looksLikeReference(token) {
  return (
    token.startsWith("#") ||
    /^https:\/\/github\.com\/\S/iu.test(token) ||
    /^[\w.-]+\/[\w.-]+#/u.test(token)
  );
}

// Trailing sentence punctuation and markdown syntax never belong to the
// reference; a digit run ends at the first non-digit.
function parseReferenceToken(token) {
  if (token.startsWith("#")) {
    const match = SAME_REPO_REFERENCE_PATTERN.exec(token);
    if (match === null || Number.parseInt(match[1], 10) <= 0) {
      return { status: "malformed" };
    }
    return { status: "parsed", target: "issue", number: Number.parseInt(match[1], 10) };
  }
  if (token.toLowerCase().startsWith("https://github.com/")) {
    const match = GITHUB_URL_PATTERN.exec(token);
    if (match === null) {
      return { status: "malformed" };
    }
    return {
      status: "parsed",
      target: match[3].toLowerCase() === "pull" ? "pull" : "issue",
      owner: match[1],
      repo: match[2],
      number: Number.parseInt(match[4], 10),
    };
  }
  const match = CROSS_REFERENCE_PATTERN.exec(token);
  if (match === null || Number.parseInt(match[3], 10) <= 0) {
    return { status: "malformed" };
  }
  return {
    status: "parsed",
    target: "issue",
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10),
  };
}

function parseTraceabilityReferences(body, repository) {
  const [owner, repo] = repository.split("/");
  const text = stripInertContent(body ?? "");
  const references = [];
  for (const match of text.matchAll(KEYWORD_PATTERN)) {
    const keyword = match[1].replace(/\s+/gu, " ").toLowerCase();
    const token = match[2];
    if (!looksLikeReference(token)) {
      continue;
    }
    const parsed = parseReferenceToken(token);
    if (parsed.status === "malformed") {
      references.push({ keyword, token, status: "malformed" });
      continue;
    }
    const sameRepository =
      parsed.owner === undefined ||
      (parsed.owner.toLowerCase() === owner.toLowerCase() &&
        parsed.repo.toLowerCase() === repo.toLowerCase());
    if (parsed.target === "pull") {
      references.push({
        keyword,
        token,
        status: sameRepository ? "same-repo-pull" : "cross-repo-pull",
        number: parsed.number,
      });
      continue;
    }
    references.push({
      keyword,
      token,
      status: sameRepository ? "same-repo-issue" : "cross-repo-issue",
      owner: parsed.owner ?? owner,
      repo: parsed.repo ?? repo,
      number: parsed.number,
    });
  }
  return references;
}

// issueRecords maps a same-repo issue number to its GitHub issue metadata:
// { found, isPullRequest, labels }. A number missing from the map is treated
// as not found.
function evaluateTraceability({ body, repository, issueRecords }) {
  const references = parseTraceabilityReferences(body, repository);
  const records = issueRecords ?? new Map();
  const findings = [];
  const acceptedIssues = [];
  const linkedIssues = [];
  const seen = new Set();

  for (const reference of references) {
    switch (reference.status) {
      case "malformed": {
        findings.push({
          kind: "malformed-link",
          message:
            `"${reference.keyword} ${reference.token}" is not a valid issue reference. ` +
            `Use "Closes #<number>" or "Part of #<number>".`,
        });
        continue;
      }
      case "cross-repo-issue":
      case "cross-repo-pull": {
        findings.push({
          kind: "cross-repo-link",
          message:
            `"${reference.keyword} ${reference.token}" points outside ${repository}; ` +
            `only same-repository issues count.`,
        });
        continue;
      }
      case "same-repo-pull": {
        findings.push({
          kind: "reference-is-pull",
          message: `"${reference.keyword} ${reference.token}" is a pull request, not an issue.`,
        });
        continue;
      }
      default:
        break;
    }
    if (seen.has(reference.number)) {
      continue;
    }
    seen.add(reference.number);
    const record = records.get(reference.number);
    if (record === undefined || record.found !== true) {
      linkedIssues.push({ number: reference.number, found: false, accepted: false });
      findings.push({
        kind: "issue-not-found",
        message: `Issue #${reference.number} does not exist in ${repository}.`,
      });
      continue;
    }
    if (record.isPullRequest === true) {
      linkedIssues.push({ number: reference.number, found: true, accepted: false });
      findings.push({
        kind: "reference-is-pull",
        message: `#${reference.number} is a pull request, not an issue.`,
      });
      continue;
    }
    const accepted = (record.labels ?? []).includes(REQUIRED_LABEL);
    linkedIssues.push({ number: reference.number, found: true, accepted });
    if (accepted) {
      acceptedIssues.push(reference.number);
    } else {
      findings.push({
        kind: "unaccepted-issue",
        message:
          `Issue #${reference.number} does not carry the "${REQUIRED_LABEL}" label. ` +
          `Only work accepted by a maintainer or triage-authorized actor is traceable.`,
      });
    }
  }

  if (references.length === 0) {
    findings.push({
      kind: "missing-link",
      message:
        `No traceability link found in the PR body. Add "Closes #<issue>" when this PR ` +
        `completes an issue, or "Part of #<issue>" for one step of larger accepted work. ` +
        `The issue must live in ${repository} and carry the "${REQUIRED_LABEL}" label.`,
    });
  }

  return {
    references,
    linkedIssues,
    acceptedIssues,
    findings,
    pass: acceptedIssues.length > 0 && findings.length === 0,
  };
}

// Draft PRs are re-checked when they become ready; other event types never
// reach the script because the workflow does not subscribe to them.
function shouldValidate({ action, draft }) {
  return SUPPORTED_ACTIONS.includes(action) && draft !== true;
}

function parseEnforceFlag(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function resolveOutcome({ pass, enforce }) {
  const blocking = enforce && !pass;
  return {
    pass,
    enforce,
    blocking,
    exitCode: blocking ? 1 : 0,
    level: pass ? "pass" : enforce ? "error" : "warning",
  };
}

function formatReport(evaluation, outcome) {
  const mode = outcome.enforce ? "enforced" : "advisory";
  const verdict = outcome.pass
    ? "PASS"
    : outcome.enforce
      ? "FAIL (enforced)"
      : "FAIL (advisory, not blocking)";
  const lines = [`Issue traceability: ${verdict} [${mode}]`];
  for (const issue of evaluation.acceptedIssues) {
    lines.push(`accepted issue: #${issue}`);
  }
  for (const finding of evaluation.findings) {
    lines.push(`${finding.kind}: ${finding.message}`);
  }
  return lines.join("\n");
}

// Workflow command values must escape these or they break the annotation line.
function annotationValue(text) {
  return text.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

function readEnv() {
  const prNumber = Number.parseInt(process.env.PR_NUMBER ?? "", 10);
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const action = process.env.EVENT_ACTION ?? "";
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repo slug.");
  }
  if (token === "") {
    throw new Error("GITHUB_TOKEN is required.");
  }
  return { prNumber, repository, token, action, enforce: parseEnforceFlag(process.env.ENFORCE) };
}

async function githubFetch(env, path) {
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return fetch(`${apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "issue-traceability",
    },
  });
}

async function fetchPullRequest(env) {
  const response = await githubFetch(env, `/repos/${env.repository}/pulls/${env.prNumber}`);
  if (!response.ok) {
    throw new Error(`Fetching pull request #${env.prNumber} failed: ${response.status}`);
  }
  const pull = await response.json();
  return { body: pull.body ?? "", draft: pull.draft === true };
}

async function fetchIssueRecord(env, number) {
  const response = await githubFetch(env, `/repos/${env.repository}/issues/${number}`);
  if (response.status === 404) {
    return { found: false, isPullRequest: false, labels: [] };
  }
  if (!response.ok) {
    throw new Error(`Fetching issue #${number} failed: ${response.status}`);
  }
  const issue = await response.json();
  return {
    found: true,
    isPullRequest: issue.pull_request !== undefined,
    labels: (issue.labels ?? []).map((label) => label.name),
  };
}

function collectIssueNumbers(body, repository) {
  const numbers = new Set();
  for (const reference of parseTraceabilityReferences(body, repository)) {
    if (reference.status === "same-repo-issue") {
      numbers.add(reference.number);
    }
  }
  return [...numbers];
}

function writeSummary(report, outcome) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const heading = outcome.pass
    ? "Issue traceability: pass"
    : outcome.enforce
      ? "Issue traceability: fail"
      : "Issue traceability: fail (advisory)";
  fs.appendFileSync(summaryPath, `### ${heading}\n\n\`\`\`\n${report}\n\`\`\`\n`);
}

async function main() {
  const env = readEnv();
  if (!SUPPORTED_ACTIONS.includes(env.action)) {
    console.log(`Skipping traceability check for event action "${env.action}".`);
    return;
  }

  const pull = await fetchPullRequest(env);
  if (!shouldValidate({ action: env.action, draft: pull.draft })) {
    console.log(`PR #${env.prNumber} is a draft; skipping until it is ready for review.`);
    return;
  }

  const issueNumbers = collectIssueNumbers(pull.body, env.repository);
  const issueRecords = new Map();
  for (const number of issueNumbers) {
    issueRecords.set(number, await fetchIssueRecord(env, number));
  }

  const evaluation = evaluateTraceability({
    body: pull.body,
    repository: env.repository,
    issueRecords,
  });
  const outcome = resolveOutcome({ pass: evaluation.pass, enforce: env.enforce });
  const report = formatReport(evaluation, outcome);
  console.log(report);

  if (!outcome.pass) {
    const command = outcome.enforce ? "error" : "warning";
    const title = outcome.enforce
      ? "Issue traceability failed"
      : "Issue traceability advisory (not blocking yet)";
    console.log(
      `::${command} title=${annotationValue(title)}::${annotationValue(report.replace(/\n/gu, " | "))}`,
    );
  }
  writeSummary(report, outcome);
  process.exitCode = outcome.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_LABEL,
  SUPPORTED_ACTIONS,
  collectIssueNumbers,
  evaluateTraceability,
  formatReport,
  parseEnforceFlag,
  parseTraceabilityReferences,
  resolveOutcome,
  shouldValidate,
  stripInertContent,
};
