const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
} = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tag_name: "v1.0.1-nightly.20260905.123",
  draft: false,
  published_at: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});

function releaseSourceFixture({
  comparisonStatus = "ahead",
  eventName = "workflow_dispatch",
  ref = "refs/heads/main",
  sha = "candidate",
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      context: {
        eventName,
        payload: { repository: { default_branch: "main" } },
        ref,
        repo: { owner: "example", repo: "app" },
        sha,
      },
      github: {
        rest: {
          repos: {
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
      },
    },
  };
}

test("allows preview releases from any branch without consulting main", async () => {
  const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
  await assertReleaseSource({ ...options, releaseChannel: "preview" });
  assert.equal(calls.length, 0);
});

for (const releaseChannel of ["stable", "nightly"]) {
  test(`rejects a manual ${releaseChannel} release from a feature branch`, async () => {
    const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
    await assert.rejects(
      assertReleaseSource({ ...options, releaseChannel }),
      new RegExp(`${releaseChannel} releases must be dispatched from main`),
    );
    assert.equal(calls.length, 0);
  });
}

for (const comparisonStatus of ["behind", "diverged"]) {
  test(`rejects a release commit that is ${comparisonStatus} from main`, async () => {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assert.rejects(
      assertCommitOnDefaultBranch({ ...options, sha: "release-commit" }),
      new RegExp(`not contained in main \\(${comparisonStatus}\\)`),
    );
  });
}

function fixture({ releases = [nightly(7)], comparisonStatus = "ahead" } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      now,
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {} },
      github: {
        rest: {
          repos: {
            listReleases() {},
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
        async paginate() {
          return releases;
        },
      },
    },
  };
}

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const { options } = fixture({
    releases: [nightly(10), nightly(1), nightly(20, { tag_name: "nightly-v0.9.0" })],
  });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("ignores stable releases and drafts when checking the gap", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("fails instead of releasing when GitHub cannot supply release state", async () => {
  const { options } = fixture();
  options.github.paginate = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(shouldReleaseNightly(options), /GitHub unavailable/);
});

for (const status of ["behind", "diverged"]) {
  test(`skips a candidate commit that is ${status} relative to the last nightly`, async () => {
    const { options } = fixture({ comparisonStatus: status });
    assert.equal(await shouldReleaseNightly(options), false);
  });
}

const { resolveLatestNightlyCommit, resolveStableCommit } = require("./check-nightly-release.cjs");

function nightlyCommitFixture({ releases, commitSha = "abc123" }) {
  const refs = [];
  const { options } = fixture({ releases });
  options.github.rest.repos.getCommit = async ({ ref }) => {
    refs.push(ref);
    return { data: { sha: commitSha } };
  };
  return { options, refs };
}

test("stable releases resolve the commit of the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [
      nightly(10, { tag_name: "v1.0.1-nightly.20260905.100" }),
      nightly(1, { tag_name: "v1.0.1-nightly.20260905.123" }),
      nightly(0, { tag_name: "v1.0.0" }),
      nightly(0, { draft: true, tag_name: "v1.0.1-nightly.20260905.999" }),
    ],
    commitSha: "deadbeef",
  });
  assert.deepEqual(await resolveLatestNightlyCommit(options), {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases derive the version from legacy nightly tags", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "nightly-v0.9.0-nightly.20260905.5" })],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).version, "0.9.0");
});

test("an explicit stable version releases the dispatch commit without any nightly", async () => {
  const { options, calls } = fixture({ releases: [] });
  const resolved = await resolveStableCommit({ ...options, explicitVersion: "1.2.3-plusplus.2" });
  assert.deepEqual(resolved, { sha: "new" });
  assert.equal(calls.length, 0, "explicit stable versions must not consult nightly state");
});

test("an empty stable version still resolves the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "v1.0.1-nightly.20260905.123" })],
    commitSha: "deadbeef",
  });
  const resolved = await resolveStableCommit({ ...options, explicitVersion: "" });
  assert.deepEqual(resolved, {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("an empty stable version still fails when no nightly is published", async () => {
  const { options } = fixture({ releases: [] });
  await assert.rejects(
    resolveStableCommit({ ...options, explicitVersion: "" }),
    /No published nightly found/,
  );
});

// Static checks over the release graph. The workflow is driven by maintainers
// only and must stay free of charge: no scheduled or tag-triggered runs, no paid
// runners, no third-party publishing channels, and only Windows x64, Linux x64,
// and a manual macOS arm64 DMG download. Mac x64 and Windows/Linux arm64 stay unbuilt.

const WORKFLOWS_DIR = path.join(__dirname, "..", "workflows");
const RELEASE_WORKFLOW = "release.yml";
const DESKTOP_WORKFLOW = "release-desktop.yml";
const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;
const HOSTED_RUNNER = /^(ubuntu|windows|macos)-(latest|\d)/i;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function stripComment(value) {
  if (value === "" || value.startsWith("|") || value.startsWith(">")) return "";
  let interpolation = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (value.startsWith("${{", index)) {
      interpolation += 1;
      index += 2;
      continue;
    }
    if (value.startsWith("}}", index) && interpolation > 0) {
      interpolation -= 1;
      index += 1;
      continue;
    }
    if (character === "#" && interpolation === 0 && /\s/.test(value[index - 1] ?? " ")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function scalar(value) {
  const trimmed = value.trim();
  const quoted = trimmed.length >= 2 && trimmed[0] === trimmed[trimmed.length - 1];
  return quoted && (trimmed[0] === '"' || trimmed[0] === "'") ? trimmed.slice(1, -1) : trimmed;
}

function blockEnd(lines, entry) {
  for (let index = entry.index + 1; index < lines.length; index += 1) {
    if (isIgnorable(lines[index])) continue;
    if (indentOf(lines[index]) <= entry.indent) return index;
  }
  return lines.length;
}

function children(lines, parent) {
  const start = parent ? parent.index + 1 : 0;
  const end = parent ? blockEnd(lines, parent) : lines.length;
  const found = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const indent = indentOf(line);
    const match = KEY_LINE.exec(line.slice(indent));
    if (!match) continue;
    found.push({
      key: match[1],
      raw: (match[2] ?? "").trim(),
      value: scalar(stripComment(match[2] ?? "")),
      index,
      indent,
    });
  }
  if (found.length === 0) return [];
  const childIndent = Math.min(...found.map((entry) => entry.indent));
  return found.filter((entry) => entry.indent === childIndent);
}

function nodeByKey(nodes, key) {
  return nodes.find((node) => node.key === key);
}

function child(lines, parent, key) {
  return parent ? nodeByKey(children(lines, parent), key) : undefined;
}

function sequenceValues(lines, entry) {
  const inline = /^\[(.*)\]$/.exec(entry.raw);
  if (inline) {
    return inline[1]
      .split(",")
      .map((item) => scalar(stripComment(item)))
      .filter(Boolean);
  }
  const items = [];
  for (let index = entry.index + 1; index < blockEnd(lines, entry); index += 1) {
    const line = lines[index];
    if (isIgnorable(line)) continue;
    const content = line.slice(indentOf(line));
    if (!content.startsWith("- ")) continue;
    items.push(scalar(stripComment(content.slice(2))));
  }
  return items;
}

function blockScalar(lines, entry) {
  const body = [];
  for (let index = entry.index + 1; index < blockEnd(lines, entry); index += 1) {
    body.push(lines[index]);
  }
  return body.join("\n");
}

function walk(lines, nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walk(lines, children(lines, node), visit);
  }
}

function loadWorkflow(fileName) {
  const source = fs.readFileSync(path.join(WORKFLOWS_DIR, fileName), "utf8").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  return { fileName, source, lines, root: children(lines, null) };
}

function triggerNode(workflow, key) {
  const on = nodeByKey(workflow.root, "on");
  return on ? nodeByKey(children(workflow.lines, on), key) : undefined;
}

function jobsOf(workflow) {
  const jobsNode = nodeByKey(workflow.root, "jobs");
  assert.ok(jobsNode, `${workflow.fileName} must declare jobs`);
  return children(workflow.lines, jobsNode).map((entry) => {
    const fields = children(workflow.lines, entry);
    const field = (key) => nodeByKey(fields, key);
    const withNode = field("with");
    const withValues = {};
    for (const node of withNode ? children(workflow.lines, withNode) : []) {
      withValues[node.key] = node.value;
    }
    const needsNode = field("needs");
    let needs = needsNode ? sequenceValues(workflow.lines, needsNode) : [];
    if (needs.length === 0 && needsNode && needsNode.value) needs = [needsNode.value];
    return {
      id: entry.key,
      name: field("name")?.value ?? "",
      runsOn: field("runs-on")?.value ?? "",
      uses: field("uses")?.value ?? "",
      needs,
      with: withValues,
      field,
      text: workflow.lines.slice(entry.index, blockEnd(workflow.lines, entry)).join("\n"),
    };
  });
}

function jobNode(workflow, jobId) {
  return nodeByKey(children(workflow.lines, nodeByKey(workflow.root, "jobs")), jobId);
}

/** Steps are sequence items, which `children` skips; each runs until the next item at its indent. */
function stepTexts(workflow, jobId) {
  const stepsNode = child(workflow.lines, jobNode(workflow, jobId), "steps");
  if (!stepsNode) return [];
  const end = blockEnd(workflow.lines, stepsNode);
  const starts = [];
  for (let index = stepsNode.index + 1; index < end; index += 1) {
    const line = workflow.lines[index];
    if (isIgnorable(line)) continue;
    const indent = indentOf(line);
    if (starts.length === 0 || indent === starts[0].indent) starts.push({ index, indent });
  }
  return starts.map(({ index }, position) => ({
    job: jobId,
    text: workflow.lines.slice(index, starts[position + 1]?.index ?? end).join("\n"),
  }));
}

function matrixValues(workflow, job, key) {
  const strategy = job.field("strategy");
  const matrix = strategy ? child(workflow.lines, strategy, "matrix") : undefined;
  const axis = matrix ? child(workflow.lines, matrix, key) : undefined;
  return axis ? sequenceValues(workflow.lines, axis) : [];
}

function expandRunner(value, job, workflow) {
  const matrix = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/.exec(value);
  if (matrix) return matrixValues(workflow, job, matrix[1]);
  const input = /\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}/.exec(value);
  if (input) {
    const passed = job.with[input[1]];
    return passed ? expandRunner(passed, job, workflow) : [];
  }
  const inline = /^\[(.*)\]$/.exec(value.trim());
  if (inline) {
    return inline[1]
      .split(",")
      .map((item) => scalar(stripComment(item)))
      .filter(Boolean);
  }
  return value.trim() ? [value.trim()] : [];
}

function runnerLabels(workflow, job) {
  const labels = [];
  for (const value of [job.runsOn, job.with.runner, job.with.verify_runner]) {
    if (value) labels.push(...expandRunner(value, job, workflow));
  }
  return labels;
}

function targetText(job) {
  return [job.with.platform, job.with.label, job.name, job.id, job.with.rust_target]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

const ARM64_ARCH = /arm64|aarch64/;
const X64_ARCH = /x64|x86_64/;

function archLabels(workflow, job) {
  const declared = [job.with.arch, job.with.rust_target]
    .filter(Boolean)
    .flatMap((value) => expandRunner(value, job, workflow))
    .map((value) => value.toLowerCase());
  return `${declared.join(" ")} ${targetText(job)}`;
}

function isArm64(workflow, job) {
  return ARM64_ARCH.test(archLabels(workflow, job));
}

function isX64(workflow, job) {
  return X64_ARCH.test(archLabels(workflow, job));
}

const release = loadWorkflow(RELEASE_WORKFLOW);

test("release only runs when a maintainer dispatches it", () => {
  const on = nodeByKey(release.root, "on");
  assert.ok(on, "release.yml must declare triggers");
  const automatic = children(release.lines, on)
    .map((node) => node.key)
    .filter((key) => key !== "workflow_dispatch");
  assert.deepEqual(automatic, [], "release.yml must not run on schedules or tag pushes");
  assert.doesNotMatch(release.source, /^\s*cron:/m);
});

test("manual dispatch offers exactly the stable, nightly and preview channels", () => {
  const dispatch = triggerNode(release, "workflow_dispatch");
  assert.ok(dispatch, "release.yml must support workflow_dispatch");
  const inputs = child(release.lines, dispatch, "inputs");
  assert.ok(inputs, "manual dispatch must declare inputs");
  const channel = child(release.lines, inputs, "channel");
  assert.ok(channel, "manual dispatch must ask for a release channel");
  const fields = children(release.lines, channel);
  const options = nodeByKey(fields, "options");
  assert.ok(options, "the channel input must list its options");
  assert.deepEqual(sequenceValues(release.lines, options).sort(), ["nightly", "preview", "stable"]);
  const fallback = nodeByKey(fields, "default");
  assert.ok(fallback && ["nightly", "preview", "stable"].includes(fallback.value));
});

const FORBIDDEN_JOB_PATTERNS = [
  [/npm/, "npm publishing"],
  [/aur/, "AUR publishing"],
  [/vercel|marketing/, "Vercel or marketing deployment"],
  [/deploy/, "deployment"],
  [/(^|[_-])eas([_-]|$)/, "EAS"],
  [/apk|android/, "APK or Android mirroring"],
  [/discord/, "Discord announcement"],
  [/openai/, "OpenAI release notes"],
  [/release[_-]?app|app[_-]?release/, "Release App automation"],
  [/relay/, "relay infrastructure"],
];

const FORBIDDEN_SECRETS = [
  ["OPENAI_API_KEY", "OpenAI"],
  ["DISCORD_", "Discord"],
  ["VERCEL_", "Vercel"],
  ["AUR_SSH", "AUR"],
  ["GOOGLE_PLAY_", "Google Play"],
  ["EAS_", "EAS"],
  ["RELEASE_APP_", "Release App"],
];

test("release graph has no paid or third-party publishing jobs", () => {
  const offenders = [];
  for (const job of jobsOf(release)) {
    const subject = `${job.id} ${job.name}`.toLowerCase();
    for (const [pattern, label] of FORBIDDEN_JOB_PATTERNS) {
      if (pattern.test(subject)) offenders.push(`${job.id}: ${label}`);
    }
    for (const workflowName of job.uses.matchAll(/\.github\/workflows\/([A-Za-z0-9_.-]+)/g)) {
      for (const [pattern, label] of FORBIDDEN_JOB_PATTERNS) {
        if (pattern.test(workflowName[1].toLowerCase())) offenders.push(`${job.id}: ${label}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("release workflow needs no third-party publishing credentials", () => {
  const used = FORBIDDEN_SECRETS.filter(([name]) => release.source.includes(name)).map(
    ([, label]) => label,
  );
  assert.deepEqual(used, []);
});

for (const fileName of [RELEASE_WORKFLOW, DESKTOP_WORKFLOW]) {
  test(`${fileName} runs on GitHub-hosted runners only`, () => {
    const workflow = loadWorkflow(fileName);
    const declared = jobsOf(workflow).flatMap((job) =>
      runnerLabels(workflow, job).map((label) => ({ job: job.id, label })),
    );
    if (fileName === RELEASE_WORKFLOW) {
      assert.ok(declared.length > 0, `${fileName} must declare a runner`);
    }
    assert.deepEqual(
      declared.filter(({ label }) => /blacksmith|self-hosted/i.test(label)),
      [],
    );
    assert.deepEqual(
      declared.filter(({ label }) => !HOSTED_RUNNER.test(label)),
      [],
    );
  });
}

const DESKTOP_TARGETS = [
  {
    key: "win",
    label: "Windows x64",
    arch: "x64",
    platform: /(?:^|[^a-z])win(?:32|dows)?(?:[^a-z]|$)/,
    runner: /^windows-(latest|\d)/,
  },
  {
    key: "linux",
    label: "Linux x64",
    arch: "x64",
    platform: /(?:^|[^a-z])linux(?:[^a-z]|$)/,
    runner: /^ubuntu-(latest|\d)/,
  },
  {
    key: "mac",
    label: "macOS arm64",
    arch: "arm64",
    platform: /(?:^|[^a-z])(?:darwin|mac|macos|osx)(?:[^a-z]|$)/,
    // GitHub's arm64 macOS images are macos-14 and newer; macos-13 is Intel.
    runner: /^macos-(1[4-9]|[2-9]\d)$/,
  },
];

function desktopTarget(job) {
  const text = targetText(job);
  return DESKTOP_TARGETS.find((target) => target.platform.test(text));
}

function matchesArch(job, arch) {
  return arch === "arm64" ? isArm64(release, job) : isX64(release, job);
}

for (const target of DESKTOP_TARGETS) {
  test(`release builds the ${target.label} desktop app on GitHub-hosted runners`, () => {
    const candidates = jobsOf(release).filter(
      (job) => target.platform.test(targetText(job)) && matchesArch(job, target.arch),
    );
    assert.ok(candidates.length > 0, `no ${target.label} desktop job is built`);
    const runners = candidates.flatMap((job) =>
      runnerLabels(release, job).map((label) => ({ job: job.id, label })),
    );
    const described = runners.map(({ job, label }) => `${job}: ${label}`).join(", ");
    assert.ok(runners.length > 0, `no runner is declared for ${target.label}`);
    assert.ok(
      runners.some(({ label }) => target.runner.test(label)),
      `${target.label} must build on a GitHub-hosted runner, got ${described}`,
    );
    assert.deepEqual(
      runners.filter(({ label }) => !HOSTED_RUNNER.test(label)),
      [],
      `${target.label} must not use a paid runner`,
    );
  });
}

test("the macOS target is one arm64 job that ships a DMG and a CLI archive", () => {
  const macJobs = jobsOf(release).filter((job) => desktopTarget(job)?.key === "mac");
  assert.equal(macJobs.length, 1, "the release graph must build exactly one macOS target");
  const [mac] = macJobs;
  assert.equal(
    mac.with.platform,
    "mac",
    `${mac.id} must call release-desktop.yml for platform mac`,
  );
  assert.equal(mac.with.target, "dmg", `${mac.id} must build the DMG installer`);
  assert.equal(mac.with.arch, "arm64", `${mac.id} must build arm64 only`);
  assert.equal(
    mac.with.cli_archive,
    "true",
    `${mac.id} must also build the darwin arm64 CLI archive`,
  );
});

test("no macOS x64 or Windows/Linux arm64 target is built", () => {
  const offenders = jobsOf(release).flatMap((job) => {
    const target = desktopTarget(job);
    if (!target) return [];
    if (target.key === "mac" && isX64(release, job)) return [`${job.id}: macOS x64`];
    if (target.key !== "mac" && isArm64(release, job)) {
      return [`${job.id}: ${target.label} arm64`];
    }
    return [];
  });
  assert.deepEqual(offenders, []);
});

test("release graph ships exactly the three free desktop targets", () => {
  const built = jobsOf(release).flatMap((job) => {
    const target = desktopTarget(job);
    return target ? [`${target.key}-${target.arch}`] : [];
  });
  assert.deepEqual(
    built.sort(),
    ["linux-x64", "mac-arm64", "win-x64"],
    "the graph ships Windows x64, Linux x64, and a manual macOS arm64 download, nothing else",
  );
});

test("release-desktop.yml collects the DMG the macOS target builds", () => {
  const desktop = loadWorkflow(DESKTOP_WORKFLOW);
  const collecting = jobsOf(desktop)
    .flatMap((job) => stepTexts(desktop, job.id))
    .find(
      (step) =>
        /patterns=\(/.test(step.text) && /"release\/\*\.(?:zip|AppImage|exe)"/.test(step.text),
    );
  assert.ok(collecting, "release-desktop.yml must collect its installers for publishing");
  assert.match(collecting.text, /release\/\*\.dmg/, "the macOS DMG must reach the release assets");
});

test("the Linux launch check runs the ++ AppImage binary, not the stock t3code", () => {
  const desktop = loadWorkflow(DESKTOP_WORKFLOW);
  const launch = jobsOf(desktop)
    .flatMap((job) => stepTexts(desktop, job.id))
    .find((step) => /Launch check/.test(step.text));
  assert.ok(launch, "release-desktop.yml must launch the packaged app");
  assert.match(
    launch.text,
    /--executable "\$RUNNER_TEMP\/squashfs-root\/t3codeplusplus"/,
    "the AppImage launch check must run the t3codeplusplus binary",
  );
  assert.doesNotMatch(
    launch.text,
    /squashfs-root\/t3code(?![a-z])/,
    "the stock t3code path is not in the ++ AppImage and fails with ENOENT",
  );
});

test("releases publish a GitHub Release with checksums", () => {
  const publishing = jobsOf(release).find((job) =>
    /action-gh-release|gh release (create|edit|upload)/.test(job.text),
  );
  assert.ok(publishing, "release.yml must publish a GitHub Release");
  assert.match(publishing.text, /sha256sum/, "checksums must be computed with sha256sum");
  assert.match(publishing.text, /SHA256SUMS/, "the GitHub Release must carry SHA256SUMS");
  assert.match(
    publishing.text,
    /files:\s|\bgh release upload\b/,
    "the GitHub Release step must attach the collected assets",
  );
});

test("stable versions keep the ++ revision format", () => {
  const scripts = [];
  walk(release.lines, release.root, (node) => {
    if (node.key === "run") scripts.push(`${node.value}\n${blockScalar(release.lines, node)}`);
  });
  const validating = scripts.filter((script) => /\[\[[^\n]*=~[^\n]*plusplus/.test(script));
  assert.ok(validating.length > 0, "stable versions must be validated against X.Y.Z-plusplus.N");
  assert.ok(
    validating.some((script) => /exit 1/.test(script)),
    "an invalid stable version must fail",
  );

  const inputs = child(release.lines, triggerNode(release, "workflow_dispatch"), "inputs");
  assert.ok(
    child(release.lines, inputs, "version"),
    "maintainers must be able to pass a ++ version",
  );
});

test("verify_ci requires Check and Agent Context Budget on the resolved commit", () => {
  const verify = jobsOf(release).find((job) => job.id === "verify_ci");
  assert.ok(verify, "release.yml must declare a verify_ci job");
  assert.ok(
    verify.needs.includes("resolve_commit"),
    "verify_ci must evaluate the commit resolve_commit picked",
  );
  assert.match(
    verify.text,
    /listForRef|check-runs/,
    "verify_ci must read check runs for the resolved commit",
  );
  assert.match(verify.text, /\bCheck\b/, "verify_ci must require the Check run");
  assert.match(
    verify.text,
    /Agent Context Budget/,
    "verify_ci must require the Agent Context Budget run",
  );
  assert.match(
    verify.text,
    /resolve_commit\.outputs\.ref/,
    "verify_ci must check the resolved commit, not the dispatch ref",
  );
  assert.match(
    verify.text,
    /conclusion[^\n]*success|success[^\n]*conclusion/i,
    "verify_ci must fail unless the required checks succeeded",
  );
});

test("every release job builds only after verify_ci passes", () => {
  for (const job of jobsOf(release)) {
    if (job.id === "resolve_commit" || job.id === "verify_ci") continue;
    assert.ok(
      job.needs.includes("verify_ci"),
      `${job.id} must declare verify_ci in needs so nothing builds on unverified commits`,
    );
  }
});

// verify_ci is skipped entirely for preview dispatches, so the preflight gate
// must treat success and skipped as passing and everything else as blocking.
// A condition that only checks resolve_commit lets failed CI through.
function evaluateJobCondition(condition, results) {
  const expression = condition
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/!cancelled\(\)/g, "true")
    .replace(/fromJSON\(/g, "JSON.parse(")
    .replace(/contains\(/g, "includes(")
    .replace(/needs\.([A-Za-z0-9_]+)\.result/g, (_, job) => JSON.stringify(results[job] ?? null));
  const includes = (values, value) => Array.isArray(values) && values.includes(value);
  return Boolean(Function("includes", `return (${expression});`)(includes));
}

test("preflight proceeds when verify_ci succeeded or was skipped, and blocks on failure", () => {
  const preflight = jobsOf(release).find((job) => job.id === "preflight");
  assert.ok(preflight, "release.yml must declare a preflight job");
  const condition = preflight.field("if")?.value ?? "";
  assert.match(
    condition,
    /needs\.verify_ci\.result/,
    "preflight must gate on verify_ci, not resolve_commit alone",
  );
  for (const [result, expected] of [
    ["success", true],
    ["skipped", true],
    ["failure", false],
    ["cancelled", false],
  ]) {
    assert.equal(
      evaluateJobCondition(condition, { resolve_commit: "success", verify_ci: result }),
      expected,
      `preflight must ${expected ? "run" : "not run"} when verify_ci is ${result}`,
    );
  }
  assert.equal(
    evaluateJobCondition(condition, { resolve_commit: "failure", verify_ci: "success" }),
    false,
    "preflight must not run when resolve_commit failed",
  );
});

test("stable dispatches refuse to republish a commit that already shipped as stable", () => {
  const resolve = jobsOf(release).find((job) => job.id === "resolve_commit");
  assert.ok(resolve, "release.yml must resolve the release commit");
  assert.match(
    resolve.text,
    /listReleases/,
    "stable resolution must consult published releases before building",
  );
  assert.match(
    resolve.text,
    /target_commitish/,
    "duplicate detection must compare the published release commit",
  );
  assert.match(resolve.text, /draft/, "draft releases must not block a stable republish");
  assert.match(
    resolve.text,
    /prerelease/,
    "nightly and preview releases must not block a stable publish",
  );
  assert.match(
    resolve.text,
    /setFailed|throw new Error/,
    "a commit that already has a published stable must fail the dispatch",
  );
});

test("stable releases keep unique version tags", () => {
  const resolve = jobsOf(release).find((job) => job.id === "resolve_commit");
  assert.ok(resolve, "release.yml must resolve the release commit");
  assert.match(
    resolve.text,
    /tag_name/,
    "stable resolution must compare against published release tags",
  );
  assert.match(
    resolve.text,
    /setFailed|throw new Error/,
    "a version tag that is already published must fail the dispatch",
  );
});

// A release's metadata tells clients which database migration the build ships,
// so every channel must generate it from the resolved version/channel. Updater
// manifests stay a stable/nightly concern: preview carries none, and macOS
// carries none on any channel because it is a manual download.

const publishing = jobsOf(release).find((job) =>
  /action-gh-release|gh release (create|edit|upload)/.test(job.text),
);

function publishingSteps() {
  assert.ok(publishing, "release.yml must publish a GitHub Release");
  return stepTexts(release, publishing.id);
}

test("release metadata is generated from the resolved version and channel", () => {
  const steps = publishingSteps();
  const generating = steps.filter((step) =>
    step.text.includes("scripts/build-release-metadata.ts"),
  );
  assert.equal(
    generating.length,
    1,
    "the publishing job must run scripts/build-release-metadata.ts exactly once",
  );
  const [step] = generating;
  const publishingIndex = steps.findIndex((candidate) => /action-gh-release/.test(candidate.text));
  assert.ok(publishingIndex >= 0, "the publishing job must publish a GitHub Release");
  assert.ok(
    steps.indexOf(step) < publishingIndex,
    "release metadata must exist before the release is published",
  );
  assert.match(
    step.text,
    /needs\.preflight\.outputs\.version/,
    "metadata must carry the resolved version, not the dispatch input",
  );
  assert.match(
    step.text,
    /needs\.preflight\.outputs\.release_channel/,
    "metadata must carry the resolved release channel",
  );
  assert.match(
    step.text,
    /release-assets/,
    "metadata must be written where the publishing job collects release assets",
  );
  assert.doesNotMatch(
    step.text,
    /^\s*if:.*(?:release_channel|inputs\.channel)/m,
    "metadata is generated on every channel, including preview",
  );
});

test("every published channel attaches release-metadata.json", () => {
  const steps = publishingSteps();
  const listing = steps.find((step) => /files<<EOF/.test(step.text));
  assert.ok(listing, "the publishing job must build the release asset list");
  assert.match(
    listing.text,
    /release-assets\/release-metadata\.json/,
    "release-metadata.json must be listed as a release asset",
  );

  const channelGated =
    /if \[\[[^\n]*preview[^\n]*\]\]([\s\S]*?)\n\s*fi\b/.exec(listing.text)?.[1] ?? "";
  assert.match(channelGated, /\.yml/, "updater manifests stay channel-gated");
  assert.doesNotMatch(
    channelGated,
    /release-metadata\.json/,
    "release metadata must not be gated to a single channel",
  );

  for (const step of steps.filter((candidate) => /action-gh-release/.test(candidate.text))) {
    assert.match(
      step.text,
      /files:\s*\$\{\{\s*steps\.release_files\.outputs\.files\s*\}\}/,
      "every publish step must attach the shared asset list",
    );
  }
});

test("preview releases refuse updater manifests but still ship release metadata", () => {
  const refusal = publishingSteps().find(
    (step) => /\.blockmap/.test(step.text) && /exit 1/.test(step.text),
  );
  assert.ok(refusal, "the publishing job must fail a preview release that carries updater files");
  assert.match(
    refusal.text,
    /^\s*if:.*release_channel\s*==\s*['"]preview['"]/m,
    "the refusal must apply only to preview releases",
  );
  assert.match(refusal.text, /\.yml/, "updater manifests must be refused");
  assert.match(refusal.text, /\.blockmap/, "updater blockmaps must be refused");
  assert.match(
    refusal.text,
    /builder-debug/,
    "electron-builder's config dump is not an updater feed",
  );
  assert.doesNotMatch(refusal.text, /\.json/, "release metadata is not an updater manifest");
});

test("the GitHub Release attaches the macOS DMG", () => {
  const listing = publishingSteps().find((step) => /files<<EOF/.test(step.text));
  assert.ok(listing, "the publishing job must build the release asset list");
  assert.match(
    listing.text,
    /release-assets\/\*\.dmg/,
    "the macOS DMG is a manual download, so it must be attached to the GitHub Release",
  );
});

test("the GitHub Release attaches the Linux .deb package", () => {
  const listing = publishingSteps().find((step) => /files<<EOF/.test(step.text));
  assert.ok(listing, "the publishing job must build the release asset list");
  assert.match(
    listing.text,
    /release-assets\/\*\.deb/,
    "the Linux .deb installer must be attached to the GitHub Release",
  );
});

test("the GitHub Release waits for every desktop target", () => {
  const targets = jobsOf(release).filter((job) => desktopTarget(job));
  assert.equal(targets.length, 3, "every shipped target needs its own desktop job in the graph");
  for (const target of targets) {
    assert.ok(
      publishing.needs.includes(target.id),
      `release must need ${target.id} so its assets are published`,
    );
  }
});

test("the release never publishes a macOS updater feed", () => {
  const steps = publishingSteps();
  const guard = steps.some(
    (step) =>
      /mac/i.test(step.text) &&
      /\.yml/.test(step.text) &&
      (/exit 1/.test(step.text) || /\brm\b/.test(step.text)),
  );
  const listing = steps.find((step) => /files<<EOF/.test(step.text));
  assert.ok(listing, "the publishing job must build the release asset list");
  const updaterEntries = [...listing.text.matchAll(/release-assets\/\S+\.yml/g)].map(
    ([entry]) => entry,
  );
  const namedUpdaterEntries =
    updaterEntries.length > 0 && updaterEntries.every((entry) => !entry.includes("*"));
  assert.ok(
    guard || namedUpdaterEntries,
    "macOS ships a manual download: release.yml must refuse latest-mac.yml/nightly-mac.yml, or list updater manifests by name instead of *.yml",
  );
  assert.doesNotMatch(
    listing.text,
    /release-assets\/[^\s]*mac[^\s]*\.yml/,
    "no macOS updater manifest may be attached",
  );
});
