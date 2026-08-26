import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Compile-time probes only. No compatibility facade is shipped. */
const probePi = (api: PiExtensionAPI): void => {
  api.registerCommand("conformance-probe", {
    description: "compile-time probe",
    async handler() {},
  });
  void api.exec("/absolute/model-picker", ["--version"]);
  api.sendUserMessage("probe");
};

const probeOmp = (api: OmpExtensionAPI): void => {
  api.registerCommand("conformance-probe", {
    description: "compile-time probe",
    async handler() {},
  });
  void api.exec("/absolute/model-picker", ["--version"]);
  api.sendUserMessage("probe");
};

void probePi;
void probeOmp;
