import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  buildDefaultSourceOptions,
  buildRouteOptions,
  computeNextRoutes,
  deriveAvailableDrivers,
  resolveDriverLabel,
  resolveOptionLabel,
  supportsContextBridgeHooks,
  type ContextBridgeFeature,
} from "./contextBridgeSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function useAvailableBridgeDrivers(environmentId: EnvironmentId) {
  const serverProviders = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  return deriveAvailableDrivers(deriveProviderInstanceEntries(serverProviders));
}

export function ContextBridgeSettingsSection({
  environmentId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const availableDrivers = useAvailableBridgeDrivers(environmentId);

  const contextBridge = settings.contextBridge;
  const defaultSource = contextBridge.defaultSource || "claudeAgent";
  const defaultSourceOptions = buildDefaultSourceOptions(defaultSource, availableDrivers);

  return (
    <SettingsSection {...searchableSetting("context-bridge")}>
      <SettingsRow
        {...searchableSetting("context-bridge-enabled")}
        description="Providers can use another provider's instructions and skills."
        control={
          <span inert={readOnly} className={readOnly ? "opacity-50" : undefined}>
            <Switch
              checked={contextBridge.enabled}
              onCheckedChange={(enabled) => updateSettings({ contextBridge: { enabled } })}
              aria-label="Enable context bridge"
            />
          </span>
        }
      />
      <SettingsRow
        {...searchableSetting("context-bridge-default-source")}
        description="Fallback source when a route is set to Default."
        control={
          <Select
            value={defaultSource}
            onValueChange={(nextSource) => {
              if (nextSource) updateSettings({ contextBridge: { defaultSource: nextSource } });
            }}
            disabled={!contextBridge.enabled || readOnly}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="Default context source">
              <SelectValue>{resolveDriverLabel(defaultSource, availableDrivers)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {defaultSourceOptions.map(({ driver, label }) => (
                <SelectItem key={driver} value={driver}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

const BRIDGE_FEATURE_ROWS = [
  { feature: "instructions", title: "Instructions" },
  { feature: "skills", title: "Skills" },
  { feature: "hooks", title: "Hooks" },
] as const satisfies ReadonlyArray<{
  feature: ContextBridgeFeature;
  title: string;
}>;

export function ProviderContextBridgeSection({
  environmentId,
  driver,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: string;
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const availableDrivers = useAvailableBridgeDrivers(environmentId);

  const contextBridge = settings.contextBridge;
  const route = contextBridge.routes[driver];
  const routeOptions = buildRouteOptions(driver, contextBridge.defaultSource, availableDrivers);

  return (
    <SettingsSection
      title="Context"
      inert={readOnly}
      aria-disabled={readOnly || undefined}
      className={readOnly ? "opacity-50 select-none" : undefined}
    >
      {BRIDGE_FEATURE_ROWS.filter(
        ({ feature }) => feature !== "hooks" || supportsContextBridgeHooks(driver),
      ).map(({ feature, title }) => {
        const value = route?.[feature] ?? "native";
        return (
          <SettingsRow
            key={feature}
            title={title}
            description={`Where ${resolveDriverLabel(driver, availableDrivers)} loads ${feature} from when the context bridge is on.`}
            control={
              <Select
                value={value}
                onValueChange={(nextValue) => {
                  if (!nextValue) return;
                  updateSettings({
                    contextBridge: {
                      routes: computeNextRoutes(contextBridge.routes, driver, feature, nextValue),
                    },
                  });
                }}
                disabled={!contextBridge.enabled}
              >
                <SelectTrigger size="sm" className="w-44" aria-label={`${title} source`}>
                  <SelectValue>{resolveOptionLabel(routeOptions, value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {routeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
