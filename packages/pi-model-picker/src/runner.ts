import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildModelPickerArguments,
  parseModelSelectionOutput,
  resolveModelPickerBinary,
} from "./selector.ts";
import type { ModelPickerRequest, ModelPickerResult } from "./types.ts";

export const runModelPicker = async (
  api: Pick<ExtensionAPI, "exec">,
  request: ModelPickerRequest,
  cwd: string,
  configuredBinary = process.env.PI_MODEL_PICKER_BIN,
): Promise<ModelPickerResult> => {
  const binary = resolveModelPickerBinary(configuredBinary);
  const args = buildModelPickerArguments(request);
  if (!binary || !args) return { ok: false, code: "selector-invalid" };

  try {
    const result = await api.exec(binary, [...args], { cwd });
    if (result.code !== 0 || result.killed) {
      return { ok: false, code: "selector-missing" };
    }
    return parseModelSelectionOutput(result.stdout);
  } catch {
    return { ok: false, code: "selector-missing" };
  }
};
