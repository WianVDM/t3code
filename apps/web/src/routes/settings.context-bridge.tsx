import { createFileRoute } from "@tanstack/react-router";
import { ContextBridgeSettingsPanel } from "../components/settings/ContextBridgeSettingsPanel";

export const Route = createFileRoute("/settings/context-bridge")({
  component: ContextBridgeSettingsPanel,
});
