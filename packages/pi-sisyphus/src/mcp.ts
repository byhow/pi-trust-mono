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

const boundedStringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const strings = value.map((item) => boundedText(item, maxLength));
  return strings.some((item) => item === undefined)
    ? undefined
    : (strings as string[]);
};

const parseProvenance = (
  value: unknown,
): McpVetEvidence["server"]["provenance"] | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => key !== "package" && key !== "version" && key !== "sha256",
    )
  ) {
    return undefined;
  }
  const packageName =
    raw.package === undefined ? undefined : boundedText(raw.package, 128);
  const version =
    raw.version === undefined ? undefined : boundedText(raw.version, 64);
  const sha256 =
    raw.sha256 === undefined ? undefined : boundedText(raw.sha256, 64);
  if (
    (raw.package !== undefined && !packageName) ||
    (raw.version !== undefined && !version) ||
    (raw.sha256 !== undefined && (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256)))
  ) {
    return undefined;
  }
  return {
    ...(packageName ? { package: packageName } : {}),
    ...(version ? { version } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
};

const parseCapabilities = (
  value: unknown,
): McpVetEvidence["server"]["capabilities"] | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        key !== "readOnly" &&
        key !== "filesystem" &&
        key !== "network" &&
        key !== "secrets",
    ) ||
    (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean") ||
    (raw.filesystem !== undefined &&
      raw.filesystem !== "none" &&
      raw.filesystem !== "workspace" &&
      raw.filesystem !== "host") ||
    (raw.network !== undefined &&
      raw.network !== "none" &&
      raw.network !== "loopback" &&
      raw.network !== "internet") ||
    (raw.secrets !== undefined && typeof raw.secrets !== "boolean")
  ) {
    return undefined;
  }
  return {
    ...(raw.readOnly !== undefined ? { readOnly: raw.readOnly } : {}),
    ...(raw.filesystem !== undefined ? { filesystem: raw.filesystem } : {}),
    ...(raw.network !== undefined ? { network: raw.network } : {}),
    ...(raw.secrets !== undefined ? { secrets: raw.secrets } : {}),
  };
};

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
      !Array.isArray(value.findings) ||
      value.findings.length > 64
    ) {
      return undefined;
    }

    const descriptorIdentity = boundedText(value.descriptorIdentity, 8_192);
    const name = boundedText(value.server.name, 128);
    const transport = value.server.transport;
    const endpoint = boundedText(value.server.endpoint, 2_048);
    const argumentShape = boundedStringArray(
      value.server.argumentShape,
      64,
      2_048,
    );
    const provenance = parseProvenance(value.server.provenance);
    const rootClassifications = boundedStringArray(
      value.server.rootClassifications,
      64,
      16,
    );
    const capabilities = parseCapabilities(value.server.capabilities);
    const credentialKeys = boundedStringArray(value.credentialKeys, 128, 128);
    if (
      !descriptorIdentity ||
      !name ||
      (transport !== "stdio" && transport !== "http") ||
      !endpoint ||
      !argumentShape ||
      !provenance ||
      !rootClassifications ||
      rootClassifications.some(
        (classification) =>
          classification !== "workspace" && classification !== "host",
      ) ||
      !capabilities ||
      !credentialKeys
    ) {
      return undefined;
    }

    const server: McpVetEvidence["server"] = {
      name,
      transport,
      endpoint,
      argumentShape,
      provenance,
      rootClassifications: rootClassifications as readonly (
        | "workspace"
        | "host"
      )[],
      capabilities,
    };
    const expectedIdentity = JSON.stringify({
      name: server.name,
      transport: server.transport,
      endpoint: server.endpoint,
      argumentShape: server.argumentShape,
      provenance: server.provenance,
      rootClassifications: server.rootClassifications,
      capabilities: server.capabilities,
      credentialKeys,
    });
    if (descriptorIdentity !== expectedIdentity) return undefined;

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
      descriptorIdentity,
      server,
      credentialKeys,
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
