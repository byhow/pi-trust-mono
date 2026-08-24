import { basename, isAbsolute } from "node:path";
import type {
  McpCapabilities,
  McpDescriptorParseResult,
  McpProvenance,
  McpServerDescriptor,
  McpVetDecision,
  McpVetFinding,
  McpVetSeverity,
} from "./types.ts";

const MAX_NAME = 128;
const MAX_VALUE = 2_048;
const MAX_ITEMS = 64;
const SENSITIVE_KEY =
  /(?:^|_)(?:api_?key|token|secret|password|credential|private_?key)(?:_|$)/iu;
const SHELLS = new Set([
  "bash",
  "cmd",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const PACKAGE_RUNNERS = new Set(["bunx", "npx", "pnpm", "yarn"]);
const EXACT_PACKAGE =
  /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu;

const boundedString = (
  value: unknown,
  maxLength = MAX_VALUE,
): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return undefined;
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return undefined;
  }
  return value;
};

const stringArray = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
  const result = [];
  for (const item of value) {
    const parsed = boundedString(item);
    if (!parsed) return undefined;
    result.push(parsed);
  }
  return result;
};

const stringRecord = (
  value: unknown,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEMS) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    const parsedKey = boundedString(key, MAX_NAME);
    const parsedValue = boundedString(item, MAX_VALUE);
    if (!parsedKey || !parsedValue) return undefined;
    result[parsedKey] = parsedValue;
  }
  return result;
};

const capabilities = (value: unknown): McpCapabilities | undefined => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<Record<keyof McpCapabilities, unknown>>;
  if (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean")
    return undefined;
  if (
    raw.filesystem !== undefined &&
    raw.filesystem !== "none" &&
    raw.filesystem !== "workspace" &&
    raw.filesystem !== "host"
  ) {
    return undefined;
  }
  if (
    raw.network !== undefined &&
    raw.network !== "none" &&
    raw.network !== "loopback" &&
    raw.network !== "internet"
  ) {
    return undefined;
  }
  if (raw.secrets !== undefined && typeof raw.secrets !== "boolean")
    return undefined;
  return {
    ...(raw.readOnly !== undefined ? { readOnly: raw.readOnly } : {}),
    ...(raw.filesystem !== undefined ? { filesystem: raw.filesystem } : {}),
    ...(raw.network !== undefined ? { network: raw.network } : {}),
    ...(raw.secrets !== undefined ? { secrets: raw.secrets } : {}),
  };
};

const provenance = (value: unknown): McpProvenance | undefined => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<Record<keyof McpProvenance, unknown>>;
  const packageName =
    raw.package === undefined
      ? undefined
      : boundedString(raw.package, MAX_NAME);
  const version =
    raw.version === undefined ? undefined : boundedString(raw.version, 64);
  const sha256 =
    raw.sha256 === undefined ? undefined : boundedString(raw.sha256, 64);
  if (
    (raw.package !== undefined && !packageName) ||
    (raw.version !== undefined && !version) ||
    (raw.sha256 !== undefined && (!sha256 || !/^[a-f0-9]{64}$/iu.test(sha256)))
  ) {
    return undefined;
  }
  return {
    ...(packageName ? { package: packageName } : {}),
    ...(version ? { version } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
};

const invalidDecision = (name = "invalid"): McpVetDecision => ({
  version: 1,
  subject: "mcp-connect",
  effect: "deny",
  score: 0,
  server: { name, transport: "stdio" },
  findings: [
    {
      code: "descriptor.invalid",
      severity: "high",
      message: "The MCP descriptor is missing required bounded fields.",
    },
  ],
});

export const parseMcpDescriptor = (
  input: unknown,
): McpDescriptorParseResult => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, decision: invalidDecision() };
  }
  const raw = input as Partial<Record<keyof McpServerDescriptor, unknown>>;
  const name = boundedString(raw.name, MAX_NAME);
  const transport = raw.transport;
  const command =
    raw.command === undefined ? undefined : boundedString(raw.command);
  const args = stringArray(raw.args);
  const url = raw.url === undefined ? undefined : boundedString(raw.url);
  const env = stringRecord(raw.env);
  const headers = stringRecord(raw.headers);
  const roots = stringArray(raw.roots);
  const parsedCapabilities = capabilities(raw.capabilities);
  const parsedProvenance = provenance(raw.provenance);

  if (
    !name ||
    (transport !== "stdio" && transport !== "http") ||
    args === undefined ||
    env === undefined ||
    headers === undefined ||
    roots === undefined ||
    parsedCapabilities === undefined ||
    parsedProvenance === undefined ||
    (transport === "stdio" && (!command || url !== undefined)) ||
    (transport === "http" && (!url || command !== undefined || args.length > 0))
  ) {
    return { ok: false, decision: invalidDecision(name) };
  }

  return {
    ok: true,
    value: {
      name,
      transport,
      ...(command ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(url ? { url } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(roots.length > 0 ? { roots } : {}),
      ...(Object.keys(parsedCapabilities).length > 0
        ? { capabilities: parsedCapabilities }
        : {}),
      ...(Object.keys(parsedProvenance).length > 0
        ? { provenance: parsedProvenance }
        : {}),
    },
  };
};

const addFinding = (
  findings: McpVetFinding[],
  code: string,
  severity: McpVetSeverity,
  message: string,
): void => {
  findings.push({ code, severity, message });
};

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

const vetHttp = (
  descriptor: McpServerDescriptor,
  findings: McpVetFinding[],
): void => {
  let url: URL;
  try {
    url = new URL(descriptor.url ?? "");
  } catch {
    addFinding(
      findings,
      "transport.url-invalid",
      "high",
      "The remote URL is invalid.",
    );
    return;
  }
  if (url.username || url.password) {
    addFinding(
      findings,
      "transport.url-credentials",
      "high",
      "Credentials must not be embedded in an MCP URL.",
    );
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) {
    addFinding(
      findings,
      "transport.loopback-http",
      "medium",
      "Loopback HTTP has no transport encryption and needs operator review.",
    );
    return;
  }
  addFinding(
    findings,
    "transport.insecure-remote",
    "high",
    "Remote MCP connections must use HTTPS.",
  );
};

const vetStdio = (
  descriptor: McpServerDescriptor,
  findings: McpVetFinding[],
): void => {
  const command = descriptor.command ?? "";
  const commandName = basename(command).toLowerCase();
  const args = descriptor.args ?? [];
  if (/\s/u.test(command)) {
    addFinding(
      findings,
      "stdio.command-not-executable",
      "high",
      "The stdio command must be one executable, not a shell expression.",
    );
  }
  if (
    SHELLS.has(commandName) &&
    args.some((arg) => arg === "-c" || arg === "/c")
  ) {
    addFinding(
      findings,
      "stdio.shell-eval",
      "high",
      "Shell-evaluated MCP launch commands are not admissible.",
    );
  }
  if (PACKAGE_RUNNERS.has(commandName)) {
    const pinned = args.some((arg) => EXACT_PACKAGE.test(arg));
    if (!pinned) {
      addFinding(
        findings,
        "provenance.package-unpinned",
        "high",
        "Package-runner MCP commands must name an exact semantic version.",
      );
    }
  } else if (!isAbsolute(command)) {
    addFinding(
      findings,
      "provenance.path-mutable",
      "medium",
      "PATH-resolved MCP executables need explicit provenance review.",
    );
  }
  if (
    isAbsolute(command) &&
    !descriptor.provenance?.sha256 &&
    !descriptor.provenance?.version
  ) {
    addFinding(
      findings,
      "provenance.unverified-binary",
      "medium",
      "Absolute MCP executables need a version or SHA-256 provenance claim.",
    );
  }
};

export const vetMcpServer = (input: unknown): McpVetDecision => {
  const parsed = parseMcpDescriptor(input);
  if (!parsed.ok) return parsed.decision;
  const descriptor = parsed.value;
  const findings: McpVetFinding[] = [];

  if (descriptor.transport === "http") vetHttp(descriptor, findings);
  else vetStdio(descriptor, findings);

  for (const key of [
    ...Object.keys(descriptor.env ?? {}),
    ...Object.keys(descriptor.headers ?? {}),
  ]) {
    if (SENSITIVE_KEY.test(key)) {
      addFinding(
        findings,
        "credential.exposure-declared",
        "medium",
        "The server receives credential-bearing configuration and needs least-privilege review.",
      );
      break;
    }
  }

  for (const root of descriptor.roots ?? []) {
    if (
      root === "/" ||
      root === "~" ||
      root.startsWith("$HOME") ||
      root.split(/[\\/]/u).includes("..")
    ) {
      addFinding(
        findings,
        "filesystem.root-overbroad",
        "high",
        "Filesystem roots must be confined to an explicit workspace subtree.",
      );
      break;
    }
  }

  const capabilities = descriptor.capabilities;
  if (
    capabilities?.filesystem === "host" &&
    capabilities.network === "internet" &&
    capabilities.secrets === true
  ) {
    addFinding(
      findings,
      "capability.toxic-combination",
      "high",
      "Host filesystem, internet, and secret access must not be granted together.",
    );
  } else if (capabilities?.readOnly === false) {
    addFinding(
      findings,
      "capability.mutating",
      "medium",
      "Mutating MCP capabilities require an attended policy decision.",
    );
  }

  const deduction = findings.reduce((total, finding) => {
    if (finding.severity === "high") return total + 40;
    if (finding.severity === "medium") return total + 15;
    return total + 5;
  }, 0);
  const effect = findings.some((finding) => finding.severity === "high")
    ? "deny"
    : findings.some((finding) => finding.severity === "medium")
      ? "ask"
      : "allow";

  return {
    version: 1,
    subject: "mcp-connect",
    effect,
    score: Math.max(0, 100 - deduction),
    server: { name: descriptor.name, transport: descriptor.transport },
    findings,
  };
};
