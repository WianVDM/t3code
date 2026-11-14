# Release runbook

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork publishes its own desktop builds from GitHub Releases. Every release is a manual
`workflow_dispatch` of `.github/workflows/release.yml`: no schedule, no tag trigger, and merging
never publishes. Desktop artifacts come from GitHub-hosted runners for Windows x64, Linux x64, and
macOS arm64, and the GitHub Release is the only distribution point. Windows and Linux x64 install
updates from the release feed; macOS arm64 is a manual download, and no other architecture ships
(no macOS Intel, Linux ARM, or Windows ARM build).

## Channels

Stable is the public channel: it is what users install, and the only channel this fork promises fixes
on. Nightly and preview exist because each serves a concrete audience stable cannot. Users who want
the next upstream patch early run nightly; maintainers testing the pipeline, a packaging change, or a
risky branch run preview. Those two audiences are the whole justification. Start from stable, and add
a channel only when someone can name its audience, who supports it, and how a change on it reaches
users.

There is no admin channel, and this fork will not add one. A build only maintainers run is
`channel=preview` or a local build. A fourth feed ordinary users cannot install from would publish
artifacts with no audience, no support promise, and no promotion path, and every client would have to
learn a channel that exists for one person.

| Channel   | Audience                        | Version                        | Release                   | Support                                                         |
| --------- | ------------------------------- | ------------------------------ | ------------------------- | --------------------------------------------------------------- |
| `stable`  | everyone                        | `X.Y.Z-plusplus.N`             | latest, not a prerelease  | supported; a defect is fixed in the next `-plusplus.N` revision |
| `nightly` | users who opt into early builds | `X.Y.Z-nightly.YYYYMMDD.<run>` | prerelease                | best effort on the newest nightly; no backports                 |
| `preview` | maintainers                     | `X.Y.Z-preview.YYYYMMDD.<run>` | prerelease with a warning | none; the release and its tag are deleted when the test ends    |

Support means this repo's maintainers answer for the channel. Stable receives fixes. A broken
nightly is dropped rather than patched, and a fix reaches nightly only if a later nightly picks it
up. Preview receives nothing: a defect found there is fixed forward on the branch or abandoned along
with the release.

`channel` defaults to `preview`, so an accidental dispatch cannot publish a stable release. The
workflow serializes nightlies and previews in one queue and gives stable its own, so a queued stable
dispatch is never dropped.

This is policy, not a status report. It says what the fork intends and promises; it does not assert
that any channel's artifacts currently install or upgrade. Each release verifies that separately, as
[Verifying a release](#verifying-a-release) describes, and a channel is never advertised on the
strength of this page alone.

## Versions

Stable uses the fork's ++ scheme: tag and version `X.Y.Z-plusplus.N`, where `X.Y.Z` is the upstream
base and `N` is the fork's revision on that base. User-facing text renders the display form
`X.Y.Z · ++N`; tags, package versions, and artifact filenames keep the machine-readable form.

Versioning is upstream-relative. The fork never picks a base of its own, so any ++ version names the
upstream release it extends and the fork's whole divergence is one revision number. That keeps a fork
release comparable with the upstream one, and it makes a new base arrive with an upstream sync rather
than a fork-only version bump.

- `N` is the part the fork owns. It increments with each stable release on the same upstream base and
  resets to `.1` when a new upstream base arrives.
- A ++ version is a later release of its base, not a semver prerelease: `v0.1.6-plusplus.2` supersedes
  `v0.1.6-plusplus.1`, and both supersede a plain `v0.1.6`. Release notes resolve their previous tag
  the same way.
- Never reuse or move a published `X.Y.Z-plusplus.N`, even for a broken build. A stable dispatch
  whose tag is already published is rejected. Ship the next revision.
- Nightly and preview build the next patch of the committed base in `apps/desktop/package.json`:
  committed `0.1.5` produces `0.1.6-nightly.<date>.<run>`. A stable dispatch with no `version` input
  ships that same base as `0.1.6-plusplus.1`. Passing `version` picks the base, the ++ revision, and
  the dispatched commit instead.
- Version changes land as ordinary PRs. Nothing in the release workflow writes to `main` or commits a
  bump back, and pushing a tag publishes nothing: the release job creates the tag.

## Promotion

- Stable is where anything users should run ends up, and nothing promotes into it automatically. A
  maintainer dispatches every stable release.
- A nightly promotes by being verified and then dispatched as stable with an empty `version`. That
  ships `X.Y.Z-plusplus.N` of the same base as a new tag, so promotion is a second publication, not a
  renamed nightly. The empty fallback always asks for `.1`; a second stable on one base passes the
  revision explicitly, such as `0.1.6-plusplus.2`.
- A nightly is a candidate, never a release. It is never marked latest and never becomes stable by
  being published.
- Preview never promotes. A change tested there reaches users only by landing on `main`, passing the
  required checks on that commit, and shipping from a stable dispatch.
- Promotion never bypasses a check. Stable requires `Check` and `Agent Context Budget` green on the
  exact commit it builds, so an urgent fix is an ordinary dispatch of that commit, not an override.

## Retention

- **Stable releases are permanent.** Their assets stay attached, and a published tag and version are
  never reused or deleted. A stable release is the only copy of that build, and a broken one is
  superseded by the next revision rather than removed.
- **Nightlies accumulate as prereleases.** Delete old ones by hand once the list gets long, keeping
  the nightly a pending stable promotion will build and any nightly a stable release's notes name.
- **Previews are deleted with their tags** when the test ends. Nothing is retained for a build end
  users never receive.
- **Retention covers GitHub Releases only.** Every channel publishes there, and this fork runs no
  package registry or mirror that would hold a second copy.

## What a run does

`.github/workflows/release.yml` builds one commit and publishes it:

1. **Resolve release commit.** Stable and nightly must be dispatched from `main`; preview may use any
   branch. Nightly and preview build the dispatched commit. So does a stable dispatch with an
   explicit `version`: it builds the dispatched default-branch commit and needs no nightly. A stable
   dispatch with an empty `version` falls back to the commit of the latest published nightly, which
   must be contained in the default branch.
2. **Preflight.** Resolves the version, tag, release name, prerelease and latest flags, and the
   previous tag in the same channel. A stable `version` that is not `X.Y.Z-plusplus.N`, or whose tag
   is already published, fails here. The Clerk and relay values baked into clients are read from the
   public, checked-in `.env.example`; no credential is involved.
3. **Build JS bundle.** Builds the server bundle, web client, and Electron main once, aligns the
   workspace package versions to the release version, and stamps the telemetry channel. Every
   platform job packages this artifact instead of rebuilding it.
4. **Desktop targets.** `desktop_linux_x64` and `desktop_win_x64` call
   `.github/workflows/release-desktop.yml` on `ubuntu-24.04`; `desktop_mac_arm64` calls it on
   `macos-15`. Each job builds its own CLI archive and smoke-tests it, then packages the app. The
   Linux job packages the AppImage and the `.deb` together. The Windows job embeds the Linux CLI
   archive as its WSL runtime and a `windows-2025` verify job runs the packaged natives, the CLI
   archive, and the resource monitor. The macOS job mounts its DMG for the same launch check and
   publishes the unsigned DMG plus the darwin arm64 CLI archive.
5. **Required checks.** Stable and nightly run a verification job that requires the aggregate `Check`
   workflow and `Agent Context Budget` to pass on the exact commit being built; a red or missing
   check means nothing publishes. Preview skips that verification: it builds any branch with no CI
   gate, and a failed required check cannot block a preview, only a stable or nightly dispatch.
6. **Publish GitHub Release.** Writes `SHA256SUMS` from the archives it uploads, refuses updater
   metadata on preview releases, drops any macOS updater files (`*-mac.yml`, the updater app zip,
   the DMG blockmap) that no install is meant to follow, merges the per-arch Windows updater manifest
   back into `latest.yml` or `nightly.yml`, and attaches every asset. A prerelease stays a draft
   until all assets are attached.

The release workflow builds no test matrix of its own; on stable and nightly the required checks are
the gate. Dispatch a stable or nightly only once they are green on the commit you intend to ship.
Preview runs no required-check verification and does not wait on them.

Assets per release:

- `T3-Code-<version>-x64.AppImage` and `T3-Code-<version>-x64.deb` (Linux),
  `T3-Code-<version>-x64.exe` (Windows), and `T3-Code-<version>-arm64.dmg` (macOS arm64, manual
  download only).
- `t3-<version>-linux-x64.tar.gz`, `t3-<version>-win32-x64.zip`, and
  `t3-<version>-darwin-arm64.tar.gz`, the self-contained CLI archives.
- `SHA256SUMS`, written from the uploaded bytes. Installers, `t3 update`, the background service, and
  SSH environments verify an archive against it before unpacking.
- Stable and nightly also carry `*.blockmap` files and the electron-builder updater manifests.
  Preview carries none: its desktop builds have no publish config, and the release job fails rather
  than upload a feed a stable or nightly install could follow. No channel carries a macOS manifest:
  unsigned mac builds ship no publish config, so electron-builder writes no feed for them, and the
  release job drops any mac updater file that shows up. Nothing on a release can offer a macOS
  update.

Desktop updates read the GitHub Release directly (`apps/desktop/src/updates/DesktopUpdates.ts`): a
`X.Y.Z-plusplus.N` build follows the `latest` manifest, a nightly build the `nightly` one. A client
can therefore see a new version before anything else points at it, so every release must attach its
CLI archives in the same run. The `release` job does that; there is no separate publish step to
order around it. Unsigned macOS builds get no publish config, so the package holds no feed and its
updater checks are disabled: nothing to read, no failed check, no version offered. A macOS user
updates by downloading the newer `.dmg` or CLI archive.

## Stable release

1. Decide what ships. An empty `version` promotes the latest published nightly, so verify that
   nightly first: run it, exercise the areas it changes, and check its assets and checksums. An
   explicit `X.Y.Z-plusplus.N` ships the dispatched `main` commit instead and needs no nightly; check
   that commit yourself, since nothing has run it as a release yet.
2. Dispatch **Release** from `main` with `channel=stable`. Leave `version` empty to ship
   `-plusplus.1` of the base the nightly previewed. Pass the full version, such as
   `0.1.6-plusplus.2`, to pick the commit and revision yourself: an urgent fix on `main`, a base no
   nightly covers, or a re-release after a bad build. The empty fallback always asks for `.1`, so a
   second stable release on the same base needs the explicit revision.
3. Read the **Resolve release commit** notice. With an empty `version` it names the nightly tag and
   commit; confirm they are the ones you verified, since a newer nightly published in between is
   built instead. With an explicit `version` it names the dispatched commit.
4. Confirm the aggregate `Check` and `Agent Context Budget` runs are green on that exact commit (the
   workflow's own verification job also enforces this for stable and nightly).
5. Watch preflight, the bundle, all three desktop jobs, and the release job. A failed target means no
   release: the release job needs all three.
6. Check the published release: not a prerelease, marked latest, named `T3 Code ++ vX.Y.Z-plusplus.N`,
   with all three installers plus the `.deb`, all three CLI archives, `SHA256SUMS`, `latest.yml`, and
   no `*-mac.yml`.
7. Smoke test the release itself: install it, open a thread, and confirm the previous ++ version is
   offered the update and installs. On macOS, mount the DMG, open the app past Gatekeeper, and
   confirm no version is offered; the DMG is the update path there. Confirm `sha256sum -c
   SHA256SUMS` passes for a CLI archive.

A stable dispatch is a real publication the moment the release job finishes. Current ++ desktop
releases are unsigned; nothing about signing blocks or delays publication.

## Nightly release

Dispatch **Release** from `main` with `channel=nightly`, when you want one. Nothing publishes nightly
on a timer, and a skipped night leaves no queue to clear. Publication requires the aggregate `Check`
and `Agent Context Budget` runs to be green on the dispatched commit.

- The version is the next patch of the committed base: committed `0.1.5` gives
  `0.1.6-nightly.<date>.<run>`.
- The release is always a prerelease, never marked latest, and its notes compare to the previous
  nightly.
- It carries the `nightly` updater feed and blockmaps, so users who opted into nightly desktop builds
  receive it.
- It commits nothing back to `main`. Retention for nightlies is in [Retention](#retention).

## Preview release

Preview is the maintainers' test train. It runs the whole pipeline (bundle, all three desktop jobs,
CLI archives, checksums, release publication) for a commit end users must never receive. Use it for a
risky branch, a packaging change, or a change to the release workflow itself.

1. Dispatch **Release** with `channel=preview` (the default) and select that branch. Preview does
   not run the required-check verification at all: it builds the branch with no CI gate, so a red or
   missing `Check` or `Agent Context Budget` run never blocks it (or is never waited on). Stable and
   nightly, by contrast, require those checks green on the dispatched commit.
2. Confirm the release starts as a draft prerelease named as a maintainer test build, with the
   warning body replacing generated notes.
3. Confirm it carries no `.yml` or `.blockmap` assets. Their absence is what keeps stable and nightly
   installs from ever being offered it.
4. Install the artifacts by hand and check what the change touches. Ways onto a preview are the
   release download, `T3CODE_CHANNEL=preview` with the install scripts, and
   `t3 update --channel preview`, which asks for confirmation unless the running build is already a
   preview.
5. Delete the release and its tag when you are done. Preview builds receive no fixes and are not
   supported.

Rerunning a preview for the same commit is fine and produces a new version. Prefer it over republishing
anything a user may already have installed.

## Verifying a release

- **Checksums.** `sha256sum -c SHA256SUMS` in a directory holding a CLI archive. A mismatch means the
  upload is incomplete or wrong; do not hand out the archive.
- **Desktop launch.** The Linux job opens the packaged AppImage under Xvfb against a seeded database
  and opens a thread; the macOS job mounts its DMG with `hdiutil` and runs the same check against
  `Contents/MacOS/<CFBundleExecutable>`. The database fixture in `scripts/fixtures/desktop-launch` is
  an old snapshot on purpose: the packaged server must migrate it forward, as it does for upgrading
  users. Do not regenerate it on schema changes.
- **Update path.** Install the previous release of the same channel, then confirm the new one is
  offered, downloads, and installs. For a release with migrations, confirm the app opens the existing
  database rather than starting empty. macOS arm64 updater checks are disabled and there is no feed
  to exercise; verify the download path below instead.
- **macOS manual download.** Take the DMG from the release page rather than the runner, mount it, and
  open the app: it is unsigned and unnotarized, so macOS gates the first open behind Gatekeeper
  (right-click, **Open**) and gates each replacement the same way. Confirm the DMG holds an arm64 app,
  that it opens and starts a thread, and that no update is offered because the updater is disabled
  in the unsigned build. Then unpack `t3-<version>-darwin-arm64.tar.gz`, check it against
  `SHA256SUMS`, clear the quarantine attribute macOS puts on a downloaded binary, and run
  `t3 --version`.
- **CLI archive.** The workflow extracts and runs each archive on its build runner, or on the
  Windows verify runner, so the darwin archive is smoke-tested on `macos-15`. If it fails there,
  nothing publishes.
- **Release-only steps.** CI's Release Smoke job exercises the version alignment, nightly and
  preview metadata, and checksum steps (`scripts/release-smoke.ts`) without publishing.

## Updating from upstream

Upstream stable is this fork's base. Keep that path ordinary:

1. When upstream publishes a stable release, start a sync PR that carries only the upstream changes.
   Land local fixes separately so the next sync stays clean.
2. Let full CI pass on the sync PR, including the shared-persistence gate that compares this
   checkout's migrations with upstream `main`. Squash merge it.
3. Confirm `apps/desktop/package.json` names the upstream base you intend to release. A version change
   is an ordinary PR; the workflow never edits it.
4. Dispatch a nightly on the new base and verify it.
5. Dispatch stable with `version` empty. The ++ revision starts again at `.1` on the new base.

## Required credentials

None. Current ++ desktop releases are unsigned: the Windows installer and CLI archive carry no
code signature, so Windows shows SmartScreen warnings on install, the Linux AppImage never carried
one, and the macOS DMG and CLI binary are neither signed nor notarized, so Gatekeeper makes the user
confirm past it on first open and again after each replacement. The release workflow needs no
signing secrets, paid certificates, or service accounts. Release publication uses the repository's
automatic workflow token (`GITHUB_TOKEN`), and the relay and Clerk values baked into clients are
public values in `.env.example`.

## Windows packaging invariants

Windows packages the bundled server and only its runtime-external dependency closure in
`resources/server.asar`. Native modules and helper executables declared unpacked in that archive must
exist at the matching paths under `resources/server.asar.unpacked`. The Windows backend reads the
archive in place through Electron.

The packaged app also ships `resources/wsl-runtime.tar.gz` with its SHA-256 sidecar: the
`t3-<version>-linux-x64.tar.gz` archive from the Linux desktop job, copied in verbatim so WSL runs the
exact bytes a Linux user downloads. WSL verifies and extracts it into
`~/.t3/wsl-runtime/sha256-<archive-digest>` inside the selected distro and reuses it for later
launches of the same update.

`scripts/build-desktop-artifact.ts` rejects a Windows package when any of these break:

- `resources/server.asar` is absent or lacks the server entry.
- A file marked unpacked in the ASAR header is missing from `resources/server.asar.unpacked`.
- The packaged primary cannot load the fff native library through its `.unpacked` sibling.
- The extracted sidecar cannot load the server entry with plain Node.
- `--wsl-runtime` was passed but the archive or its SHA-256 sidecar is missing, or the sidecar digest
  does not match the emitted archive.
- The WSL archive is not a Linux CLI release archive: it must unpack to one `t3-<version>-linux-x64`
  directory holding `t3`, `client/`, and `node_modules/`, and must not carry a loose `bin.mjs`.
- The external resource monitor is absent.
- The unpacked application contains more than 80 files.

Keep JavaScript and package metadata inside `app.asar` and unpack only native libraries and helper
executables. Avoid enabling whole-package smart unpacking: each loose file adds work to NSIS
installation and counts against the payload limit. NSIS differential packaging stays enabled, so a
sidecar layout change costs one larger download and later releases keep small blockmap diffs.

## Troubleshooting

- **`No published nightly found. Stable releases build the latest nightly commit.`** The stable
  dispatch had no `version` input, so it needs a nightly to promote. Dispatch a nightly and let it
  publish, or pass an explicit `X.Y.Z-plusplus.N` to build the dispatched commit instead.
- **`stable releases must be dispatched from main; selected ...`** Re-dispatch from `main`. Use
  `channel=preview` for a branch build.
- **`Invalid release version ... (expected X.Y.Z-plusplus.N)`** The `version` input allows only an
  upstream base plus a ++ revision. A bare `X.Y.Z` and other suffixes are rejected.
- **A stable version's tag already exists** A published release owns its tag and version. Bump the ++
  revision; do not delete the release or move the tag to force the old version through.
- **`Preview releases must not carry updater metadata`** The packaging step emitted a feed for a
  preview version. Fix the publish-config condition; do not drop the guard.
- **Windows verify job fails** The packaged natives, CLI archive, or resource monitor would not run
  for users. Treat the build as broken and fix it before publishing again.
- **Linux AppImage launch check fails** The shipped backend or bundle cannot start. The database
  fixture must migrate forward; do not work around a failure by regenerating it.
- **macOS launch check fails** The DMG would not mount, or the app inside could not start after
  mounting. Treat the build as broken; macOS users would get a download that never opens.
- **A `*-mac.yml` reaches a release** Unsigned macOS builds emit no updater metadata, so a mac
  manifest on a release means a publish config leaked into the build or the "Drop macOS updater
  metadata" step missed it. Fix the source of it; a mac feed advertises an update path no build is
  verified to follow.

## Recovery

- **A job failed before publication.** Rerun the failed jobs; nothing is public yet and the tag does
  not exist. Once a release is published, its version is spent.
- **The GitHub Release is public and wrong.** Users may already have updated, so unpublishing does not
  undo it. Ship the next `-plusplus.N` revision on the same base, or a new base, with the fix. The
  published tag stays rejected for future dispatches, so deleting the release buys nothing.
- **An update feed points at a bad version.** Publish a newer version rather than editing or deleting
  the older release assets: clients compare versions, and a missing asset breaks the update instead of
  skipping it.
- **A preview leaked into the wrong channel.** Check for `.yml` and `.blockmap` assets on the preview
  release. Their presence is the bug; the release job's guard is what prevents a repeat.
- **A nightly is bad.** Stop promoting it. Nothing was marked latest, so stable users were never
  offered it; publish the next nightly and let that one be the candidate.
