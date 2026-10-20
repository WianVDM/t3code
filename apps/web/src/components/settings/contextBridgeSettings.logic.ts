import {
  type ContextBridgeRoute,
  type ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

export type ContextBridgeFeature = "instructions" | "skills" | "hooks";

export interface DriverOption {
  readonly driver: string;
  readonly label: string;
}

export interface RouteOption {
  readonly value: string;
  readonly label: string;
}

interface MutableContextBridgeRoute {
  instructions?: string;
  skills?: string;
  hooks?: string;
}

export function deriveAvailableDrivers(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<DriverOption> {
  const seen = new Set<string>();
  const drivers: DriverOption[] = [];

  for (const entry of entries) {
    const driver = String(entry.driverKind);
    if (!seen.has(driver)) {
      seen.add(driver);
      const label = PROVIDER_DISPLAY_NAMES[entry.driverKind] ?? entry.displayName ?? driver;
      drivers.push({ driver, label });
    }
  }

  return drivers;
}

export function resolveDriverLabel(
  driver: string,
  availableDrivers: ReadonlyArray<DriverOption>,
): string {
  const found = availableDrivers.find((d) => d.driver === driver);
  if (found) return found.label;
  const kind = driver as ProviderDriverKind;
  return PROVIDER_DISPLAY_NAMES[kind] ?? driver;
}

export function buildRouteOptions(
  rowDriver: string,
  defaultSource: string,
  availableDrivers: ReadonlyArray<DriverOption>,
): ReadonlyArray<RouteOption> {
  const defaultSourceLabel = resolveDriverLabel(defaultSource, availableDrivers);
  const options: RouteOption[] = [
    { value: "native", label: "Native" },
    { value: "default", label: "Default (" + defaultSourceLabel + ")" },
  ];

  for (const { driver, label } of availableDrivers) {
    if (driver !== rowDriver) {
      options.push({ value: driver, label });
    }
  }

  return options;
}

export function computeNextRoutes(
  currentRoutes: Readonly<Record<string, ContextBridgeRoute>> | undefined,
  driver: string,
  feature: ContextBridgeFeature,
  value: string,
): Record<string, ContextBridgeRoute> {
  const next: Record<string, ContextBridgeRoute> = {};

  if (currentRoutes) {
    for (const [key, route] of Object.entries(currentRoutes)) {
      if (key !== driver) {
        next[key] = { ...route };
      }
    }
  }

  const existingRoute = currentRoutes?.[driver];
  const updatedRoute: MutableContextBridgeRoute = { ...existingRoute };

  if (!value || value === "native") {
    delete updatedRoute[feature];
  } else {
    updatedRoute[feature] = value;
  }

  const isInstructionsNative = !updatedRoute.instructions || updatedRoute.instructions === "native";
  const isSkillsNative = !updatedRoute.skills || updatedRoute.skills === "native";
  const isHooksNative = !updatedRoute.hooks || updatedRoute.hooks === "native";

  const isAllNative = isInstructionsNative && isSkillsNative && isHooksNative;

  if (!isAllNative) {
    next[driver] = updatedRoute as ContextBridgeRoute;
  }

  return next;
}
