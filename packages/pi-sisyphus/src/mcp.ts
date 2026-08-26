import { resolveSisyphusBinary } from "./engine.ts";
import { type SisyphusProcessResult, spawnSisyphus } from "./process.ts";
import type {
  McpServerDescriptor,
  McpVetEvidence,
  McpVetResult,
} from "./types.ts";

const MAX_BYTES = 64 * 1024;

export type McpVetExecutor = (
  binary: string,
  input: string,
) => Promise<SisyphusProcessResult>;

const boundedText = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  })
    ? value
    : undefined;

const parseEvidence = (raw: string): McpVetEvidence | undefined => {
  if (Buffer.byteLength(raw) > MAX_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<McpVetEvidence>;
    if (
      value.version !== 1 ||
      value.subject !== "mcp-connect" ||
      (value.advisoryEffect !== "allow" &&
        value.advisoryEffect !== "deny" &&
        value.advisoryEffect !== "ask") ||
      typeof value.server !== "object" ||
      value.server === null ||
      !Array.isArray(value.credentialKeys) ||
      value.credentialKeys.length > 128 ||
      !Array.isArray(value.findings) ||
      value.findings.length > 64
    ) {
      return undefined;
    }
    const name = boundedText(value.server.name, 128);
    const transport = value.server.transport;
    const credentialKeys = value.credentialKeys.map((key) =>
      boundedText(key, 128),
    );
    if (
      !name ||
      (transport !== "stdio" && transport !== "http") ||
      credentialKeys.some((key) => key === undefined)
    ) {
      return undefined;
    }
    const findings = value.findings.map((finding) => {
      if (typeof finding !== "object" || finding === null) return undefined;
      const code = boundedText(finding.code, 128);
      const message = boundedText(finding.message, 1_024);
      const severity = finding.severity;
      return code &&
        message &&
        (severity === "high" || severity === "medium" || severity === "low")
        ? { code, message, severity }
        : undefined;
    });
    if (findings.some((finding) => finding === undefined)) return undefined;
    return {
      version: 1,
      subject: "mcp-connect",
      advisoryEffect: value.advisoryEffect,
      server: { name, transport },
      credentialKeys: credentialKeys as string[],
      findings: findings as McpVetEvidence["findings"],
    };
  } catch {
    return undefined;
  }
};

const executeVet: McpVetExecutor = (binary, input) =>
  spawnSisyphus(binary, ["vet", "mcp", "-"], input, {});

export const vetMcp = async (
  descriptor: McpServerDescriptor,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  execute: McpVetExecutor = executeVet,
): Promise<McpVetResult> => {
  const binary = resolveSisyphusBinary(environment);
  let input: string;
  try {
    input = JSON.stringify(descriptor);
  } catch {
    return { ok: false, code: "policy-config-invalid" };
  }
  if (!binary || Buffer.byteLength(input) > MAX_BYTES) {
    return { ok: false, code: "policy-config-invalid" };
  }

  try {
    const result = await execute(binary, input);
    if (result.killed || result.code < 0) {
      return { ok: false, code: "engine-unavailable" };
    }
    const evidence = parseEvidence(result.stdout);
    const expectedExit = evidence?.advisoryEffect === "allow" ? 0 : 1;
    if (!evidence || result.code !== expectedExit) {
      return { ok: false, code: "engine-invalid" };
    }
    return { ok: true, evidence };
  } catch {
    return { ok: false, code: "engine-unavailable" };
  }
};
