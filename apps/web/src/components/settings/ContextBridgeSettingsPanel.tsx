import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";
import { type ContextBridgeRoute, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  buildRouteOptions,
  computeNextRoutes,
  deriveAvailableDrivers,
  resolveDriverLabel,
  type ContextBridgeFeature,
} from "./contextBridgeSettings.logic";

export function ContextBridgeSettingsPanel({
  environmentId: propEnvironmentId,
}: {
  readonly environmentId?: EnvironmentId;
} = {}) {
  const { environment } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const effectiveEnvironmentId =
    propEnvironmentId ?? environment?.environmentId ?? primaryEnvironmentId;

  if (!effectiveEnvironmentId) {
    return (
      <SettingsPageContainer className="gap-8">
        <SettingsSection id="context-bridge" title="Context bridge" variant="plain">
          <p className="p-8 text-sm text-muted-foreground">
            Connect an execution environment to configure the context bridge.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <ContextBridgeSettingsContent environmentId={effectiveEnvironmentId} />;
}

function ContextBridgeSettingsContent({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const providerInstanceEntries = useMemo(
    () => deriveProviderInstanceEntries(serverProviders),
    [serverProviders],
  );

  const availableDrivers = useMemo(
    () => deriveAvailableDrivers(providerInstanceEntries),
    [providerInstanceEntries],
  );

  const contextBridge = settings.contextBridge ?? {
    enabled: false,
    defaultSource: "claudeAgent",
    routes: {},
  };

  const enabled = contextBridge.enabled ?? false;
  const defaultSource = contextBridge.defaultSource || "claudeAgent";
  const routes: Record<string, ContextBridgeRoute> = contextBridge.routes ?? {};

  const handleEnabledChange = useCallback(
    (nextEnabled: boolean) => {
      updateSettings({
        contextBridge: {
          enabled: nextEnabled,
        },
      });
    },
    [updateSettings],
  );

  const handleDefaultSourceChange = useCallback(
    (nextSource: string | null) => {
      if (!nextSource) return;
      updateSettings({
        contextBridge: {
          defaultSource: nextSource,
        },
      });
    },
    [updateSettings],
  );

  const handleRouteChange = useCallback(
    (driver: string, feature: ContextBridgeFeature, value: string) => {
      const nextRoutes = computeNextRoutes(routes, driver, feature, value);
      updateSettings({
        contextBridge: {
          routes: nextRoutes,
        },
      });
    },
    [routes, updateSettings],
  );

  const defaultSourceOptions = useMemo(() => {
    if (availableDrivers.length === 0) {
      return [
        {
          driver: defaultSource,
          label: resolveDriverLabel(defaultSource, availableDrivers),
        },
      ];
    }
    if (!availableDrivers.some((d) => d.driver === defaultSource)) {
      return [
        ...availableDrivers,
        {
          driver: defaultSource,
          label: resolveDriverLabel(defaultSource, availableDrivers),
        },
      ];
    }
    return availableDrivers;
  }, [availableDrivers, defaultSource]);

  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection id="context-bridge" title="Context bridge" variant="plain">
        <SettingsGroup>
          <SettingsRow
            {...searchableSetting("context-bridge-enabled")}
            description="Providers can use another provider's instructions and skills."
            control={<Switch checked={enabled} onCheckedChange={handleEnabledChange} />}
          />
          <SettingsRow
            {...searchableSetting("context-bridge-default-source")}
            description="Fallback source when a route is set to Default."
            control={
              <Select
                value={defaultSource}
                onValueChange={handleDefaultSourceChange}
                disabled={!enabled}
              >
                <SelectTrigger size="sm" className="w-48">
                  <SelectValue />
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
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection id="context-bridge-routes" title="Routes" variant="plain">
        <SettingsGroup divided={false} className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/4">Provider</TableHead>
                <TableHead className="w-1/4">Instructions</TableHead>
                <TableHead className="w-1/4">Skills</TableHead>
                <TableHead className="w-1/4">Hooks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {availableDrivers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No configured providers found.
                  </TableCell>
                </TableRow>
              ) : (
                availableDrivers.map(({ driver, label }) => {
                  const isPi = driver === "pi";
                  const isAntigravity = driver === "antigravity";
                  const route = routes[driver];
                  const routeOptions = buildRouteOptions(driver, defaultSource, availableDrivers);

                  return (
                    <TableRow key={driver}>
                      <TableCell className="font-medium">{label}</TableCell>
                      <TableCell>
                        {isPi ? (
                          <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground">Native only</span>
                            <span className="text-[11px] text-muted-foreground/75">
                              Pi reads its own files
                            </span>
                          </div>
                        ) : (
                          <Select
                            value={route?.instructions ?? "native"}
                            onValueChange={(val) => {
                              if (val) handleRouteChange(driver, "instructions", val);
                            }}
                            disabled={!enabled}
                          >
                            <SelectTrigger size="sm" className="w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {routeOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        {isPi ? (
                          <span className="text-xs text-muted-foreground">Native only</span>
                        ) : (
                          <Select
                            value={route?.skills ?? "native"}
                            onValueChange={(val) => {
                              if (val) handleRouteChange(driver, "skills", val);
                            }}
                            disabled={!enabled}
                          >
                            <SelectTrigger size="sm" className="w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {routeOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        {isAntigravity ? (
                          <Select
                            value={route?.hooks ?? "native"}
                            onValueChange={(val) => {
                              if (val) handleRouteChange(driver, "hooks", val);
                            }}
                            disabled={!enabled}
                          >
                            <SelectTrigger size="sm" className="w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {routeOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
