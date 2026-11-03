import * as Schema from "effect/Schema";

import { BRAND_ASSET_PATHS } from "./brand-assets.ts";

export type DesktopBuildVariant = "official" | "fork";

export const DESKTOP_VARIANT_ENV_VAR = "T3CODE_DESKTOP_VARIANT";

export class InvalidDesktopBuildVariantError extends Schema.TaggedError<InvalidDesktopBuildVariantError>()(
  "InvalidDesktopBuildVariantError",
  {
    value: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid ${DESKTOP_VARIANT_ENV_VAR} '${this.value}'; only "fork" or an unset value is supported.`;
  }
}

export const FORK_DESKTOP_BUILD = {
  packageName: "t3code-fork",
  productName: "T3 Code (Fork)",
  appId: "com.wianvdm.t3code.fork",
  artifactName: "T3-Code-Fork-${version}-${arch}.${ext}",
  windowsIconIco: BRAND_ASSET_PATHS.forkWindowsIconIco,
  // A fork build must never default to the official update feed.
  updateRepository: "WianVDM/t3code",
} as const;

export function resolveDesktopBuildVariant(value: string | undefined): DesktopBuildVariant {
  const trimmed = value?.trim();
  if (!trimmed) return "official";
  if (trimmed === "fork") return "fork";
  throw new InvalidDesktopBuildVariantError({ value: trimmed });
}
