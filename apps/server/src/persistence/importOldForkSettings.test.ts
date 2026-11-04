// @effect-diagnostics nodeBuiltinImport:off - Fixture setup exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ServerSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SECRET_REDACTED } from "../settingsSecrets.ts";
import {
  OldForkSettingsError,
  mergeSettings,
  overlayOldForkFiles,
  requiredSettingsSecretNames,
} from "./importOldForkSettings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const providerConfigSecretName = (instanceId: string, driver: string, field: string) =>
  `provider-config-${encode(instanceId)}-${encode(driver)}-${encode(field)}`;
const providerEnvSecretName = (instanceId: string, variable: string) =>
  `provider-env-${encode(instanceId)}-${encode(variable)}`;

const makeBaseDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-import-old-fork-settings-"));

interface Homes {
  readonly baseDir: string;
  readonly sourceUserdata: string;
  readonly destinationUserdata: string;
}

const makeHomes = (): Homes => {
  const baseDir = makeBaseDir();
  const sourceUserdata = NodePath.join(baseDir, "old-fork", "userdata");
  const destinationUserdata = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(NodePath.join(sourceUserdata, "secrets"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(destinationUserdata, "secrets"), { recursive: true });
  return { baseDir, sourceUserdata, destinationUserdata };
};

const writeSettings = (userdata: string, settings: Record<string, unknown>) => {
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
};

const writeSecret = (userdata: string, name: string, bytes: Buffer) => {
  NodeFS.writeFileSync(NodePath.join(userdata, "secrets", `${name}.bin`), bytes);
};

const readSettings = (userdata: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(userdata, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;

const readSecret = (userdata: string, name: string): Buffer =>
  NodeFS.readFileSync(NodePath.join(userdata, "secrets", `${name}.bin`));

const destinationSettingsPath = (userdata: string) => NodePath.join(userdata, "settings.json");

const runOverlay = (homes: Homes) =>
  overlayOldForkFiles(homes.sourceUserdata, homes.destinationUserdata).pipe(
    Effect.provide(NodeServices.layer),
  );

const mainInstance = (config: Record<string, unknown>, environment?: ReadonlyArray<unknown>) => ({
  driver: "antigravity",
  enabled: true,
  ...(environment === undefined ? {} : { environment }),
  config,
});

describe("mergeSettings", () => {
  it("source leaves win while destination-only siblings survive", () => {
    const merged = mergeSettings(
      { nested: { keep: 1, overwrite: "destination" }, top: "destination" },
      { nested: { overwrite: "source" } },
    );
    assert.deepEqual(merged, { nested: { keep: 1, overwrite: "source" }, top: "destination" });
  });

  it("source arrays replace destination arrays wholesale", () => {
    const merged = mergeSettings({ hosts: ["a", "b"] }, { hosts: ["c"] });
    assert.deepEqual(merged.hosts, ["c"]);
  });

  it("destination-only keys and unknown source keys all survive", () => {
    const merged = mergeSettings(
      { destinationOnly: true, shared: { destinationLeaf: 1 } },
      { unknownFutureKey: "kept", shared: { sourceLeaf: 2 } },
    );
    assert.deepEqual(merged, {
      destinationOnly: true,
      unknownFutureKey: "kept",
      shared: { destinationLeaf: 1, sourceLeaf: 2 },
    });
  });
});

describe("requiredSettingsSecretNames", () => {
  it("finds redacted credentials only, not literals or external references", () => {
    const settings = decodeServerSettings({
      providerInstances: {
        main: {
          driver: "antigravity",
          config: {
            apiKey: SECRET_REDACTED,
            gcpProject: "not-a-credential",
          },
          environment: [
            { name: "FORK_TOKEN", value: "", sensitive: true, valueRedacted: true },
            { name: "FORK_PLAIN", value: "literal", sensitive: false },
            {
              name: "FORK_REFERENCED",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "prod/token" },
            },
          ],
        },
      },
    });

    assert.deepEqual(
      [...requiredSettingsSecretNames(settings)].sort(),
      [
        providerConfigSecretName("main", "antigravity", "apiKey"),
        providerEnvSecretName("main", "FORK_TOKEN"),
      ].sort(),
    );
  });
});

describe("overlayOldForkFiles", () => {
  it.effect("overlays provider-auth credentials and copies their required secret files", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      const secretName = providerConfigSecretName("main", "antigravity", "apiKey");
      const secretBytes = Buffer.from("fork-gemini-key");
      writeSettings(homes.sourceUserdata, {
        providerInstances: {
          main: mainInstance({ authMethod: "gemini-api-key", apiKey: SECRET_REDACTED }),
        },
        defaultAutoPull: true,
      });
      writeSecret(homes.sourceUserdata, secretName, secretBytes);
      writeSettings(homes.destinationUserdata, {
        providerInstances: {
          main: mainInstance({ authMethod: "oauth-personal", apiKey: "" }),
        },
        snoozePresets: [{ label: "Local", days: 3 }],
      });

      yield* runOverlay(homes);

      const settings = readSettings(homes.destinationUserdata);
      assert.deepEqual(settings.providerInstances, {
        main: mainInstance({ authMethod: "gemini-api-key", apiKey: SECRET_REDACTED }),
      });
      // Source-only and destination-only plain settings merge the same way.
      assert.equal(settings.defaultAutoPull, true);
      assert.deepEqual(settings.snoozePresets, [{ label: "Local", days: 3 }]);
      // The credential file the redacted value points at is copied byte for byte.
      assert.deepEqual(readSecret(homes.destinationUserdata, secretName), secretBytes);
    }),
  );

  it.effect("discovers redacted provider environment variables as required secrets", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      const secretName = providerEnvSecretName("main", "ANTIGRAVITY_TOKEN");
      const secretBytes = Buffer.from("fork-env-token");
      writeSettings(homes.sourceUserdata, {
        providerInstances: {
          main: mainInstance({ authMethod: "oauth-personal" }, [
            { name: "ANTIGRAVITY_TOKEN", value: "", sensitive: true, valueRedacted: true },
          ]),
        },
      });
      writeSecret(homes.sourceUserdata, secretName, secretBytes);
      writeSettings(homes.destinationUserdata, { defaultAutoPull: false });

      yield* runOverlay(homes);

      assert.deepEqual(readSecret(homes.destinationUserdata, secretName), secretBytes);
    }),
  );

  it.effect("blocks with a typed error when a required secret file is missing", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      const secretName = providerConfigSecretName("main", "antigravity", "apiKey");
      writeSettings(homes.sourceUserdata, {
        providerInstances: {
          main: mainInstance({ authMethod: "gemini-api-key", apiKey: SECRET_REDACTED }),
        },
      });
      // The redacted value promises a secret file the old fork does not have.
      writeSettings(homes.destinationUserdata, { defaultAutoPull: false });
      const before = NodeFS.readFileSync(
        destinationSettingsPath(homes.destinationUserdata),
        "utf8",
      );

      const error = yield* runOverlay(homes).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OldForkSettingsError);
      assert.equal((error as OldForkSettingsError)._tag, "OldForkSettingsError");
      expect(String(error)).toContain(secretName);
      // Nothing is written half-way: the destination keeps its own settings.
      assert.equal(
        NodeFS.readFileSync(destinationSettingsPath(homes.destinationUserdata), "utf8"),
        before,
      );
    }),
  );

  it.effect("leaves identity, cloud, and session keys from the destination untouched", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      writeSettings(homes.sourceUserdata, {
        identity: { machineId: "fork-machine" },
        cloud: { link: "fork-cloud" },
        sessions: { auth: "fork-sessions" },
        defaultAutoPull: true,
      });
      writeSettings(homes.destinationUserdata, {
        identity: { machineId: "local-machine" },
        cloud: { link: "local-cloud" },
        sessions: { auth: "local-sessions" },
      });

      yield* runOverlay(homes);

      const settings = readSettings(homes.destinationUserdata);
      assert.deepEqual(settings.identity, { machineId: "local-machine" });
      assert.deepEqual(settings.cloud, { link: "local-cloud" });
      assert.deepEqual(settings.sessions, { auth: "local-sessions" });
      // Only the excluded keys are protected; ordinary settings still overlay.
      assert.equal(settings.defaultAutoPull, true);
    }),
  );

  it.effect("passes external secret references through without requiring a secret file", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      const reference = { provider: "vault", reference: "prod/gemini-api-key" };
      writeSettings(homes.sourceUserdata, {
        providerInstances: {
          main: mainInstance({ authMethod: "gemini-api-key", apiKey: reference }),
        },
      });
      writeSettings(homes.destinationUserdata, { defaultAutoPull: false });

      yield* runOverlay(homes);

      const settings = readSettings(homes.destinationUserdata);
      assert.deepEqual(settings.providerInstances, {
        main: mainInstance({ authMethod: "gemini-api-key", apiKey: reference }),
      });
    }),
  );

  it.effect("copies provider-auth credential files from the old fork", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      const authBytes = Buffer.from("fork-provider-auth");
      writeSettings(homes.sourceUserdata, { defaultAutoPull: true });
      writeSettings(homes.destinationUserdata, { defaultAutoPull: false });
      NodeFS.mkdirSync(NodePath.join(homes.sourceUserdata, "provider-auth"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(
          homes.sourceUserdata,
          "provider-auth",
          "provider-auth-" + "a".repeat(64) + ".bin",
        ),
        authBytes,
      );

      yield* runOverlay(homes);

      assert.deepEqual(
        NodeFS.readFileSync(
          NodePath.join(
            homes.destinationUserdata,
            "provider-auth",
            "provider-auth-" + "a".repeat(64) + ".bin",
          ),
        ),
        authBytes,
      );
    }),
  );

  it.effect("copies source themes while destination-only themes survive", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      writeSettings(homes.sourceUserdata, { defaultAutoPull: true });
      writeSettings(homes.destinationUserdata, { defaultAutoPull: false });
      NodeFS.mkdirSync(NodePath.join(homes.sourceUserdata, "themes"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(homes.destinationUserdata, "themes"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(homes.sourceUserdata, "themes", "fork-theme.json"),
        '{"name":"fork"}\n',
      );
      NodeFS.writeFileSync(
        NodePath.join(homes.destinationUserdata, "themes", "local-theme.json"),
        '{"name":"local"}\n',
      );

      yield* runOverlay(homes);

      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(homes.destinationUserdata, "themes", "fork-theme.json"),
          "utf8",
        ),
        '{"name":"fork"}\n',
      );
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(homes.destinationUserdata, "themes", "local-theme.json"),
          "utf8",
        ),
        '{"name":"local"}\n',
      );
    }),
  );

  it.effect("converges when the overlay runs again", () =>
    Effect.gen(function* () {
      const homes = makeHomes();
      const secretName = providerConfigSecretName("main", "antigravity", "apiKey");
      writeSettings(homes.sourceUserdata, {
        providerInstances: {
          main: mainInstance({ authMethod: "gemini-api-key", apiKey: SECRET_REDACTED }),
        },
      });
      writeSecret(homes.sourceUserdata, secretName, Buffer.from("fork-gemini-key"));
      writeSettings(homes.destinationUserdata, { defaultAutoPull: false });

      yield* runOverlay(homes);
      const settingsAfterFirst = NodeFS.readFileSync(
        destinationSettingsPath(homes.destinationUserdata),
        "utf8",
      );
      const secretAfterFirst = readSecret(homes.destinationUserdata, secretName);

      yield* runOverlay(homes);

      assert.equal(
        NodeFS.readFileSync(destinationSettingsPath(homes.destinationUserdata), "utf8"),
        settingsAfterFirst,
      );
      assert.deepEqual(readSecret(homes.destinationUserdata, secretName), secretAfterFirst);
    }),
  );
});
