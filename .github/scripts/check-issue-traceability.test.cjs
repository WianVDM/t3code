const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
} = require("./check-issue-traceability.cjs");

const REPO = "WianVDM/t3code";

const parse = (body) => parseTraceabilityReferences(body, REPO);

const evaluate = (body, records = []) =>
  evaluateTraceability({
    body,
    repository: REPO,
    issueRecords: new Map(records.map((record) => [record.number, record])),
  });

const acceptedIssue = (number, extraLabels = []) => ({
  number,
  found: true,
  isPullRequest: false,
  labels: [REQUIRED_LABEL, ...extraLabels],
});

test("parses closing keywords and part-of markers case-insensitively", () => {
  const references = parse("Closes #43\npart of #44\nFIXES #1\nResolved #2\nClose #5\nClosed #6");
  assert.deepEqual(
    references.map((reference) => [reference.keyword, reference.number, reference.status]),
    [
      ["closes", 43, "same-repo-issue"],
      ["part of", 44, "same-repo-issue"],
      ["fixes", 1, "same-repo-issue"],
      ["resolved", 2, "same-repo-issue"],
      ["close", 5, "same-repo-issue"],
      ["closed", 6, "same-repo-issue"],
    ],
  );
});

test("normalizes whitespace inside the part-of keyword", () => {
  const references = parse("Part   of #43");
  assert.equal(references.length, 1);
  assert.equal(references[0].keyword, "part of");
  assert.equal(references[0].number, 43);
});

test("ignores keywords not followed by a reference attempt", () => {
  assert.deepEqual(parse("This closes the gap and fixes the download page's Linux cards."), []);
  assert.deepEqual(parse("The policy receives fixes, nightly and preview stay separate."), []);
  assert.deepEqual(parse("discloses #5 without a word boundary"), []);
  assert.deepEqual(parse("Stacked on #61 (t3/b44-ownership) has no keyword"), []);
});

test("strips HTML comments so template instructions never count", () => {
  const body = [
    "<!-- Use `Closes #<number>` or `Part of #<number>` per #43. -->",
    "## Change",
    "Part of #43",
  ].join("\n");
  assert.equal(stripInertContent(body).includes("#43"), true);
  const references = parse(body);
  assert.equal(references.length, 1);
  assert.equal(references[0].number, 43);
});

test("ignores keywords inside fenced code blocks and inline code", () => {
  const body = [
    "Part of #43",
    "```",
    "Closes #999999",
    "```",
    "Rejected forms: `Closes #abc`, `Closes pingdotgg/t3code#100`, `Part of #`.",
  ].join("\n");
  const references = parse(body);
  assert.equal(references.length, 1);
  assert.equal(references[0].number, 43);
});

test("handles trailing punctuation and markdown syntax around references", () => {
  assert.equal(parse("Closes #43.")[0].number, 43);
  assert.equal(parse("(Part of #44)")[0].number, 44);
  assert.equal(
    parse("Resolves https://github.com/WianVDM/t3code/issues/41, closes #41 too").length,
    2,
  );
});

test("treats explicit same-owner/repo references as same-repo, case-insensitively", () => {
  const references = parse(
    "Closes WianVDM/t3code#43 and part of wianvdm/t3code#44 and resolves https://github.com/WianVDM/t3code/issues/45",
  );
  assert.deepEqual(
    references.map((reference) => [reference.status, reference.number]),
    [
      ["same-repo-issue", 43],
      ["same-repo-issue", 44],
      ["same-repo-issue", 45],
    ],
  );
});

test("detects cross-repository references in both shorthand and URL form", () => {
  const references = parse(
    "Closes pingdotgg/t3code#100\nPart of https://github.com/pingdotgg/t3code/issues/101",
  );
  assert.deepEqual(
    references.map((reference) => reference.status),
    ["cross-repo-issue", "cross-repo-issue"],
  );
});

test("classifies pull request URL references separately from issues", () => {
  const references = parse(
    "Closes https://github.com/WianVDM/t3code/pull/65\nPart of https://github.com/pingdotgg/t3code/pull/9",
  );
  assert.deepEqual(
    references.map((reference) => reference.status),
    ["same-repo-pull", "cross-repo-pull"],
  );
});

test("flags malformed references without swallowing valid ones", () => {
  const malformed = [
    "Closes #",
    "Closes #abc",
    "Closes #0",
    "Closes #12a",
    "Part of https://github.com/WianVDM",
    "Closes wianvdm/t3code#x",
    "Fixes https://github.com/WianVDM/t3code/releases/latest",
  ];
  for (const body of malformed) {
    const references = parse(body);
    assert.equal(references.length, 1, `expected one reference in "${body}"`);
    assert.equal(references[0].status, "malformed", `expected malformed for "${body}"`);
  }
});

test("collectIssueNumbers deduplicates same-repo issue references", () => {
  const numbers = collectIssueNumbers(
    "Closes #43\nPart of #43\nAlso see #99 and Closes pingdotgg/t3code#7",
    REPO,
  );
  assert.deepEqual(numbers, [43]);
});

test("passes when at least one same-repo accepted issue is linked cleanly", () => {
  const evaluation = evaluate("Part of #43", [acceptedIssue(43, "plusplus")]);
  assert.equal(evaluation.pass, true);
  assert.deepEqual(evaluation.findings, []);
  assert.deepEqual(evaluation.acceptedIssues, [43]);
  assert.deepEqual(evaluation.linkedIssues, [{ number: 43, found: true, accepted: true }]);
});

test("fails with missing-link when the body has no traceability reference", () => {
  const evaluation = evaluate("## Change\nNothing linked here.");
  assert.equal(evaluation.pass, false);
  assert.deepEqual(
    evaluation.findings.map((finding) => finding.kind),
    ["missing-link"],
  );
});

test("fails when the linked issue lacks the accepted label", () => {
  const evaluation = evaluate("Closes #43", [
    { number: 43, found: true, isPullRequest: false, labels: ["plusplus", "needs-triage"] },
  ]);
  assert.equal(evaluation.pass, false);
  assert.deepEqual(
    evaluation.findings.map((finding) => finding.kind),
    ["unaccepted-issue"],
  );
});

test("fails when the linked issue does not exist", () => {
  const evaluation = evaluate("Closes #434343", [
    { number: 434343, found: false, isPullRequest: false, labels: [] },
  ]);
  assert.equal(evaluation.pass, false);
  assert.deepEqual(
    evaluation.findings.map((finding) => finding.kind),
    ["issue-not-found"],
  );
  const withoutRecord = evaluate("Closes #434343");
  assert.deepEqual(
    withoutRecord.findings.map((finding) => finding.kind),
    ["issue-not-found"],
  );
});

test("fails when the reference resolves to a pull request", () => {
  const viaNumber = evaluate("Closes #65", [{ number: 65, found: true, isPullRequest: true }]);
  assert.deepEqual(
    viaNumber.findings.map((finding) => finding.kind),
    ["reference-is-pull"],
  );
  assert.equal(viaNumber.pass, false);

  const viaUrl = evaluate("Closes https://github.com/WianVDM/t3code/pull/65\nPart of #43", [
    acceptedIssue(43),
  ]);
  assert.equal(viaUrl.pass, false);
  assert.deepEqual(
    viaUrl.findings.map((finding) => finding.kind),
    ["reference-is-pull"],
  );
});

test("fails on cross-repo links even alongside a valid accepted link", () => {
  const evaluation = evaluate("Part of #43\nCloses pingdotgg/t3code#100", [acceptedIssue(43)]);
  assert.equal(evaluation.pass, false);
  assert.deepEqual(evaluation.acceptedIssues, [43]);
  assert.deepEqual(
    evaluation.findings.map((finding) => finding.kind),
    ["cross-repo-link"],
  );
});

test("fails on malformed links even alongside a valid accepted link", () => {
  const evaluation = evaluate("Part of #43\nCloses #abc", [acceptedIssue(43)]);
  assert.equal(evaluation.pass, false);
  assert.deepEqual(
    evaluation.findings.map((finding) => finding.kind),
    ["malformed-link"],
  );
});

test("leaving the unedited template placeholder fails as malformed", () => {
  const templateBody = "## Traceability\n\n<!-- instructions -->\n\nPart of #\n";
  const evaluation = evaluate(templateBody, [acceptedIssue(43)]);
  assert.equal(evaluation.pass, false);
  assert.deepEqual(
    evaluation.findings.map((finding) => finding.kind),
    ["malformed-link"],
  );
});

test("validates a duplicate link once and still passes", () => {
  const evaluation = evaluate("Closes #43\nPart of #43\nCloses #43", [acceptedIssue(43)]);
  assert.equal(evaluation.pass, true);
  assert.equal(evaluation.linkedIssues.length, 1);
  assert.deepEqual(evaluation.acceptedIssues, [43]);
});

test("multiple accepted links pass together", () => {
  const evaluation = evaluate("Closes #41\nPart of #44", [acceptedIssue(41), acceptedIssue(44)]);
  assert.equal(evaluation.pass, true);
  assert.deepEqual(evaluation.acceptedIssues, [41, 44]);
});

test("validates on every required PR event and skips drafts", () => {
  for (const action of SUPPORTED_ACTIONS) {
    assert.equal(shouldValidate({ action, draft: false }), true, `action ${action}`);
    assert.equal(shouldValidate({ action, draft: true }), false, `draft on ${action}`);
  }
  assert.deepEqual(SUPPORTED_ACTIONS, [
    "opened",
    "edited",
    "reopened",
    "synchronize",
    "ready_for_review",
  ]);
  assert.equal(shouldValidate({ action: "labeled", draft: false }), false);
  assert.equal(shouldValidate({ action: "closed", draft: false }), false);
  assert.equal(shouldValidate({ action: "", draft: false }), false);
});

test("enforce flag parsing accepts only an explicit true", () => {
  assert.equal(parseEnforceFlag("true"), true);
  assert.equal(parseEnforceFlag("TRUE"), true);
  assert.equal(parseEnforceFlag(" true "), true);
  assert.equal(parseEnforceFlag("false"), false);
  assert.equal(parseEnforceFlag("1"), false);
  assert.equal(parseEnforceFlag(""), false);
  assert.equal(parseEnforceFlag(undefined), false);
});

test("advisory mode never blocks while enforced mode exits nonzero on failure", () => {
  assert.deepEqual(resolveOutcome({ pass: true, enforce: false }), {
    pass: true,
    enforce: false,
    blocking: false,
    exitCode: 0,
    level: "pass",
  });
  assert.deepEqual(resolveOutcome({ pass: false, enforce: false }), {
    pass: false,
    enforce: false,
    blocking: false,
    exitCode: 0,
    level: "warning",
  });
  assert.deepEqual(resolveOutcome({ pass: true, enforce: true }), {
    pass: true,
    enforce: true,
    blocking: false,
    exitCode: 0,
    level: "pass",
  });
  assert.deepEqual(resolveOutcome({ pass: false, enforce: true }), {
    pass: false,
    enforce: true,
    blocking: true,
    exitCode: 1,
    level: "error",
  });
});

test("report names the mode, verdict, accepted issues, and findings", () => {
  const evaluation = evaluate("Part of #43\nCloses #999", [acceptedIssue(43)]);
  const advisory = formatReport(evaluation, resolveOutcome({ pass: false, enforce: false }));
  assert.match(advisory, /FAIL \(advisory, not blocking\) \[advisory\]/);
  assert.match(advisory, /accepted issue: #43/);
  assert.match(advisory, /issue-not-found: Issue #999 does not exist/);

  const enforcedPass = formatReport(
    evaluate("Part of #43", [acceptedIssue(43)]),
    resolveOutcome({ pass: true, enforce: true }),
  );
  assert.match(enforcedPass, /PASS \[enforced\]/);
});
