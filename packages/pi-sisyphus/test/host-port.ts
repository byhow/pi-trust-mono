import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Compile-time probes only. No compatibility facade is shipped. */
const probePi = (api: PiExtensionAPI): void => {
  api.on("tool_call", async () => undefined);
  api.on("tool_result", async () => undefined);
  api.on("session_shutdown", async () => undefined);
  api.registerCommand("conformance-probe", {
    description: "compile-time probe",
    async handler() {},
  });
  api.sendUserMessage("probe");
};

const probeOmp = (api: OmpExtensionAPI): void => {
  api.on("tool_call", async () => undefined);
  api.on("tool_result", async () => undefined);
  api.on("session_shutdown", async () => undefined);
  api.registerCommand("conformance-probe", {
    description: "compile-time probe",
    async handler() {},
  });
  api.sendUserMessage("probe");
};

void probePi;
void probeOmp;
