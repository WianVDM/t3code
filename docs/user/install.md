# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first.

## Requirements

Windows x64, Linux x64, or macOS arm64. Every release is published on
[GitHub Releases](https://github.com/WianVDM/t3code/releases) only. There is no
macOS Intel, Linux ARM, or Windows ARM build, no mobile app, and nothing here
needs Node.js or npm.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/WianVDM/t3code/main/scripts/install.ps1 | iex
```

The installer downloads the release archive for your platform and links `t3`
into `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows). If your shell
reports `command not found` afterwards, that directory is not on your `PATH`
yet; the installer prints the line to add. Set `T3CODE_CHANNEL=nightly` to
install the nightly train, or `T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                                    |
| Start the server without a browser               | `t3 serve`                                                              |
| Use it from your other devices                   | `t3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md))               |
| Move to the newest release                       | `t3 update`                                                             |
| Reclaim database space                           | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Import an old fork's history                     | `t3 import-old-fork --source <path-to-old-statev2.sqlite>`              |
| Remove it again                                  | `t3 uninstall`                                                          |

`import-old-fork` copies an old fork's V2 database into this installation only
when the destination database does not exist yet; it never overwrites existing
state. Stop any running server first, and pass `--base-dir` to import into a
different T3 home.

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### From an archive

Every release also carries the CLI on its own: a `.tar.gz` for Linux x64 and
macOS arm64, a `.zip` for Windows x64, and `SHA256SUMS` beside them. Unpack one and put `t3`
somewhere on your `PATH`. Updates are then manual, so download the newer archive
and replace the binary. Use the installer instead when you want `t3 update` and
the background service to follow releases for you.

### Coming from npm or npx

`npm install -g t3`, `npx t3@latest`, `pnpm dlx`, and `bunx` no longer install
or update T3 Code. If your `t3` came from one of them, stop the server, install
the current release with the installer above, and use `t3 update` from then on.
Projects, threads, and settings in your T3 home directory are kept.

## Desktop app

Download the installer from [GitHub Releases](https://github.com/WianVDM/t3code/releases):

| Platform    | File                             |
| ----------- | -------------------------------- |
| Windows     | `T3-Code-<version>-x64.exe`      |
| Linux       | `T3-Code-<version>-x64.AppImage` |
| Linux       | `T3-Code-<version>-x64.deb`      |
| macOS arm64 | `T3-Code-<version>-arm64.dmg`    |

The AppImage has to be executable (`chmod +x`) before the first run. Open the
`.dmg` and drag T3 Code into Applications on macOS. There is no macOS Intel,
Linux ARM, or Windows ARM build, no mobile app, and no Homebrew, AUR, or Nix
package.

The macOS build is unsigned and has no updater feed. macOS may warn that it
cannot verify the developer on first open; right-click the app and choose
**Open** to run it anyway, and expect the same after each update. To update,
download the newer `.dmg` and replace the app yourself. On Windows and Linux
the app installs its own updates from the same releases; see
[Updating T3 Code](./updating.md).

### The `t3` command

The desktop app includes the `t3` command-line tool. To run it from any
terminal, open **Settings → About** and choose **Install** next to
**t3 command**. On Linux it adds a `t3` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3 Code. Homebrew and
Chocolatey installs compare against the version their package manager offers,
which can trail the npm release; update Claude installed with Chocolatey
through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure T3 Code for everyone on a machine.
