import type { HostExtensionAPI } from "./host.ts";
import {
  buildModelPickerArguments,
  parseModelSelectionOutput,
  resolveModelPickerBinary,
} from "./selector.ts";
import type { ModelChoiceRequest, ModelChoiceResult } from "./types.ts";

export const runModelChoice = async (
  api: Pick<HostExtensionAPI, "exec">,
  request: ModelChoiceRequest,
  cwd: string,
  configuredBinary = process.env.PI_MODEL_PICKER_BIN,
): Promise<ModelChoiceResult> => {
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
