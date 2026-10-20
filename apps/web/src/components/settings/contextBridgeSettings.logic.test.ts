import { describe, expect, it } from "vite-plus/test";
import {
  type ContextBridgeRoute,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildRouteOptions,
  computeNextRoutes,
  deriveAvailableDrivers,
  resolveDriverLabel,
} from "./contextBridgeSettings.logic";

function makeMockInstanceEntry(
  instanceId: string,
  driverKind: string,
  displayName = "",
): ProviderInstanceEntry {
  const driver = ProviderDriverKind.make(driverKind);
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: driver,
    displayName: displayName || driverKind,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {
      instanceId: ProviderInstanceId.make(instanceId),
      driver,
      enabled: true,
      status: "ready",
    } as unknown as ServerProvider,
    models: [],
  };
}

describe("contextBridgeSettings.logic", () => {
  const claudeEntry = makeMockInstanceEntry("claude-default", "claudeAgent", "Claude");
  const codexEntry1 = makeMockInstanceEntry("codex-default", "codex", "Codex");
  const codexEntry2 = makeMockInstanceEntry("codex-custom", "codex", "Custom Codex");
  const antigravityEntry = makeMockInstanceEntry(
    "antigravity-default",
    "antigravity",
    "Antigravity",
  );
  const piEntry = makeMockInstanceEntry("pi-default", "pi", "Pi");

  describe("deriveAvailableDrivers", () => {
    it("deduplicates multiple instances of the same driver kind and preserves order", () => {
      const drivers = deriveAvailableDrivers([
        claudeEntry,
        codexEntry1,
        codexEntry2,
        antigravityEntry,
        piEntry,
      ]);
      expect(drivers).toEqual([
        { driver: "claudeAgent", label: "Claude" },
        { driver: "codex", label: "Codex" },
        { driver: "antigravity", label: "Antigravity" },
        { driver: "pi", label: "Pi" },
      ]);
    });
  });

  describe("resolveDriverLabel", () => {
    const availableDrivers = [
      { driver: "claudeAgent", label: "Claude" },
      { driver: "codex", label: "Codex" },
    ];
    it("resolves label from available drivers or provider display names", () => {
      expect(resolveDriverLabel("claudeAgent", availableDrivers)).toBe("Claude");
      expect(resolveDriverLabel("codex", availableDrivers)).toBe("Codex");
      expect(resolveDriverLabel("antigravity", availableDrivers)).toBe("Antigravity");
      expect(resolveDriverLabel("unknownDriver", availableDrivers)).toBe("unknownDriver");
    });
  });

  describe("buildRouteOptions", () => {
    const availableDrivers = [
      { driver: "claudeAgent", label: "Claude" },
      { driver: "codex", label: "Codex" },
      { driver: "antigravity", label: "Antigravity" },
      { driver: "pi", label: "Pi" },
    ];
    it("excludes the row own driver from options", () => {
      const options = buildRouteOptions("codex", "claudeAgent", availableDrivers);
      expect(options.some((opt) => opt.value === "codex")).toBe(false);
      expect(options).toEqual([
        { value: "native", label: "Native" },
        { value: "default", label: "Default (Claude)" },
        { value: "claudeAgent", label: "Claude" },
        { value: "antigravity", label: "Antigravity" },
        { value: "pi", label: "Pi" },
      ]);
    });
    it("excludes claudeAgent when building options for the claudeAgent row", () => {
      const options = buildRouteOptions("claudeAgent", "claudeAgent", availableDrivers);
      expect(options.some((opt) => opt.value === "claudeAgent")).toBe(false);
      expect(options).toEqual([
        { value: "native", label: "Native" },
        { value: "default", label: "Default (Claude)" },
        { value: "codex", label: "Codex" },
        { value: "antigravity", label: "Antigravity" },
        { value: "pi", label: "Pi" },
      ]);
    });
  });

  describe("computeNextRoutes", () => {
    it("sets a feature on an empty route map", () => {
      const next = computeNextRoutes({}, "codex", "instructions", "default");
      expect(next).toEqual({
        codex: { instructions: "default" },
      });
    });
    it("sets multiple features on the same driver", () => {
      const initial: Record<string, ContextBridgeRoute> = {
        codex: { instructions: "default" },
      };
      const next = computeNextRoutes(initial, "codex", "skills", "claudeAgent");
      expect(next).toEqual({
        codex: { instructions: "default", skills: "claudeAgent" },
      });
    });
    it("resets a feature to native while keeping other features on that driver", () => {
      const initial: Record<string, ContextBridgeRoute> = {
        codex: { instructions: "default", skills: "claudeAgent" },
      };
      const next = computeNextRoutes(initial, "codex", "instructions", "native");
      expect(next).toEqual({
        codex: { skills: "claudeAgent" },
      });
    });
    it("removes the driver entry completely when all its features are reset to native", () => {
      const initial: Record<string, ContextBridgeRoute> = {
        codex: { instructions: "default" },
      };
      const next = computeNextRoutes(initial, "codex", "instructions", "native");
      expect(next).toEqual({});
      expect("codex" in next).toBe(false);
    });
    it("leaves other providers untouched when modifying a driver route", () => {
      const initial: Record<string, ContextBridgeRoute> = {
        claudeAgent: { skills: "default" },
        antigravity: { hooks: "claudeAgent", instructions: "codex" },
        codex: { instructions: "default" },
      };
      const next = computeNextRoutes(initial, "codex", "instructions", "native");
      expect(next).toEqual({
        claudeAgent: { skills: "default" },
        antigravity: { hooks: "claudeAgent", instructions: "codex" },
      });
      expect(next.claudeAgent).toEqual(initial.claudeAgent);
      expect(next.antigravity).toEqual(initial.antigravity);
    });
    it("handles undefined routes map gracefully", () => {
      const next = computeNextRoutes(undefined, "antigravity", "hooks", "claudeAgent");
      expect(next).toEqual({
        antigravity: { hooks: "claudeAgent" },
      });
    });
  });
});
