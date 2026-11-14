// @effect-diagnostics nodeBuiltinImport:off - Drives the real installers against a local GitHub fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPTS_DIR = NodePath.resolve(import.meta.dirname, "../../../scripts");

async function listenFixture(
  handler: (pathname: string, accept: string | undefined) => { status?: number; body?: unknown },
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const result = handler(url.pathname, request.headers.accept);
    response.statusCode = result.status ?? 200;
    response.setHeader("Content-Type", "application/json");
    // The API pretty-prints and the shell installer reads it line by line.
    response.end(JSON.stringify(result.body ?? [], null, 2));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runSpawn(
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function rewriteInstaller(source: string, scriptName: string, origin: string) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-reject-"));
  const text = await NodeFSP.readFile(NodePath.resolve(SCRIPTS_DIR, source), "utf8");
  const installer = NodePath.join(root, scriptName);
  await NodeFSP.writeFile(installer, text.replace(/https:\/\/(api\.)?github\.com/g, origin));
  return { root, installer };
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- packages/plusplus cannot import @t3tools/shared/HostProcess; shared depends on plusplus.
describe.skipIf(process.platform !== "linux")("installer fork source guard", () => {
  it("rejects a bare upstream tag the latest endpoint reports as stable", async () => {
    const fixture = await listenFixture((pathname, accept) =>
      pathname === "/WianVDM/t3code/releases/latest" && accept === "application/json"
        ? { body: { tag_name: "v0.1.7" } }
        : { status: 404 },
    );
    try {
      const { root, installer } = await rewriteInstaller(
        "install.sh",
        "install.sh",
        fixture.origin,
      );
      const { code, output } = await runSpawn("sh", [installer], {
        T3CODE_VERSION: "",
        T3CODE_CHANNEL: "stable",
        T3CODE_HOME: NodePath.join(root, "home"),
        T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
        T3CODE_RELEASE_BASE_URL: fixture.origin,
      });
      expect(code, output).not.toBe(0);
      expect(output).toContain("could not find a stable release");
      expect(output).not.toContain("npm");
      await NodeFSP.rm(root, { recursive: true, force: true });
    } finally {
      await fixture.close();
    }
  });

  it("reports a missing archive without npm recovery guidance", async () => {
    const fixture = await listenFixture(() => ({ status: 404 }));
    try {
      const { root, installer } = await rewriteInstaller(
        "install.sh",
        "install.sh",
        fixture.origin,
      );
      const { code, output } = await runSpawn("sh", [installer], {
        T3CODE_VERSION: "9.9.9-plusplus.1",
        T3CODE_HOME: NodePath.join(root, "home"),
        T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
        T3CODE_RELEASE_BASE_URL: fixture.origin,
      });
      expect(code, output).not.toBe(0);
      expect(output).toContain("has no release archive");
      expect(output).not.toContain("npm");
      await NodeFSP.rm(root, { recursive: true, force: true });
    } finally {
      await fixture.close();
    }
  });
});

const powerShell = ["pwsh", "powershell"].find(
  (command) =>
    NodeChildProcess.spawnSync(command, ["-NoProfile", "-Command", "exit 0"]).status === 0,
);

describe.skipIf(powerShell === undefined)("installer powershell", () => {
  // An empty-string env value corrupts the whole Windows environment block; remove it instead.
  const archEnv: Readonly<Record<string, string | undefined>> = {
    PROCESSOR_ARCHITECTURE: "AMD64",
    PROCESSOR_ARCHITEW6432: undefined,
  };

  async function runPsInstaller(
    handler: (pathname: string, accept: string | undefined) => { status?: number; body?: unknown },
    env: Readonly<Record<string, string | undefined>>,
    prepare?: (root: string) => Promise<void>,
  ) {
    const fixture = await listenFixture(handler);
    try {
      const { root, installer } = await rewriteInstaller(
        "install.ps1",
        "install.ps1",
        fixture.origin,
      );
      await prepare?.(root);
      const result = await runSpawn(powerShell!, ["-NoProfile", "-File", installer], {
        ...archEnv,
        T3CODE_CHANNEL: "stable",
        T3CODE_VERSION: "",
        T3CODE_HOME: NodePath.join(root, "home"),
        T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
        T3CODE_RELEASE_BASE_URL: fixture.origin,
        ...env,
      });
      return { ...result, root };
    } finally {
      await fixture.close();
    }
  }

  it("rejects a bare upstream tag the latest endpoint reports as stable", async () => {
    const { code, output, root } = await runPsInstaller(
      (pathname, accept) =>
        pathname === "/WianVDM/t3code/releases/latest" && accept === "application/json"
          ? { body: { tag_name: "v0.1.7" } }
          : { status: 404 },
      {},
    );
    expect(code, output).not.toBe(0);
    expect(output).toContain("could not find a stable release");
    expect(output).not.toContain("npm");
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("reports a missing archive without npm recovery guidance", async () => {
    const { code, output, root } = await runPsInstaller(() => ({ status: 404 }), {
      T3CODE_VERSION: "9.9.9-plusplus.1",
    });
    expect(code, output).not.toBe(0);
    expect(output).toContain("has no release archive");
    expect(output).not.toContain("npm");
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  // The success path writes Windows-shaped runtime\versions paths, so it needs Windows.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- packages/plusplus cannot import @t3tools/shared/HostProcess; shared depends on plusplus.
  describe.skipIf(process.platform !== "win32")("on Windows", () => {
    it("installs the plusplus tag the fork latest endpoint reports", async () => {
      const version = "1.2.3-plusplus.4";
      const { code, output, root } = await runPsInstaller(
        (pathname, accept) =>
          pathname === "/WianVDM/t3code/releases/latest" && accept === "application/json"
            ? { body: { tag_name: `v${version}` } }
            : { status: 404 },
        {},
        async (preparedRoot) => {
          // A completed install isolates release resolution from archive downloads.
          const target = NodePath.join(preparedRoot, "home", "runtime", "versions", version);
          await NodeFSP.mkdir(target, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), version);
        },
      );
      try {
        expect(code, output).toBe(0);
        expect(output).toContain(`Installed T3 Code ++ ${version}`);
        const shim = await NodeFSP.readFile(NodePath.join(root, "bin", "t3.cmd"), "utf8");
        expect(shim).toContain(NodePath.join(root, "home", "runtime", "versions", version));
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  });
});
