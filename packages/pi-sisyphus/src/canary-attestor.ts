import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  open,
  opendir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProvenanceBoundTrustEvaluation } from "./engine.ts";
import type { TrustInput } from "./types.ts";

const CONTRACT = "zoysia.fleet-lab.sisyphus-attestation";
const MODE = "fleet-lab-v1";
const RECEIPT_PREFIX = "attestation-";
const RECEIPT_SUFFIX = ".json";
const MAX_RECEIPTS = 32;
const MAX_RECEIPT_BYTES = 4 * 1024;
const MAX_POLICY_ID_BYTES = 146;
const DIRECTORY_MODE = 0o700;
const TEMPORARY_MODE = 0o600;
const RECEIPT_MODE = 0o400;
const MODE_BITS = 0o7777n;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DECISION_EFFECTS = new Set(["allow", "deny", "ask", "modify"]);
const FAILURE_CODES = new Set([
  "policy-config-invalid",
  "engine-unavailable",
  "engine-invalid",
]);
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const POLICY_ID_PATTERN = /^sisyphus:\/\/bundle\/[a-z0-9][a-z0-9._-]{0,127}$/u;
const RECEIPT_NAME_PATTERN =
  /^attestation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const ARMING_KEYS = [
  "PI_SISYPHUS_CANARY_MODE",
  "PI_SISYPHUS_CANARY_ACTION",
  "PI_SISYPHUS_CANARY_CHALLENGE",
  "PI_SISYPHUS_CANARY_RECEIPT_DIR",
  "PI_SISYPHUS_CANARY_POLICY_ID",
] as const;

type ResourceScope = "workspace" | "external" | "unknown" | "not-applicable";

type CanaryActionDefinition = {
  readonly id:
    | "normalize-slug"
    | "read-only-scout"
    | "denied-action"
    | "worker-interruption"
    | "coordinator-restart";
  readonly definitionVersion: 1;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly resourceScope: ResourceScope;
};

const ACTION_DEFINITIONS: readonly CanaryActionDefinition[] = [
  {
    id: "normalize-slug",
    definitionVersion: 1,
    tool: "Bash",
    input: { command: "printf '%s\\n' 'hello-world'" },
    resourceScope: "not-applicable",
  },
  {
    id: "read-only-scout",
    definitionVersion: 1,
    tool: "Read",
    input: { path: "README.md" },
    resourceScope: "workspace",
  },
  {
    id: "denied-action",
    definitionVersion: 1,
    tool: "Write",
    input: {
      path: "fleet-lab-denied.txt",
      content: "this write must not be authorized\n",
    },
    resourceScope: "workspace",
  },
  {
    id: "worker-interruption",
    definitionVersion: 1,
    tool: "Bash",
    input: { command: "printf '%s\\n' 'worker-interruption-canary'" },
    resourceScope: "not-applicable",
  },
  {
    id: "coordinator-restart",
    definitionVersion: 1,
    tool: "Bash",
    input: { command: "printf '%s\\n' 'coordinator-restart-canary'" },
    resourceScope: "not-applicable",
  },
];

const publicDefinitionBytes = (definition: CanaryActionDefinition): string =>
  JSON.stringify({
    id: definition.id,
    definitionVersion: definition.definitionVersion,
    tool: definition.tool,
    input: definition.input,
    resourceScope: definition.resourceScope,
  });

const digestPublicDefinition = (definition: CanaryActionDefinition): string =>
  createHash("sha256").update(publicDefinitionBytes(definition)).digest("hex");

export type CanaryActionDescriptor = {
  readonly id: CanaryActionDefinition["id"];
  readonly definitionVersion: 1;
  readonly definitionDigest: string;
};

export const canaryActionDescriptors: readonly CanaryActionDescriptor[] =
  Object.freeze(
    ACTION_DEFINITIONS.map((definition) =>
      Object.freeze({
        id: definition.id,
        definitionVersion: definition.definitionVersion,
        definitionDigest: digestPublicDefinition(definition),
      }),
    ),
  );

export type CanaryRecordResult = "not-target" | "recorded";

export interface CanaryAttestor {
  record(
    input: TrustInput,
    evaluation: ProvenanceBoundTrustEvaluation,
  ): Promise<CanaryRecordResult>;
}

export type CanaryAttestationErrorCode =
  | "configuration-invalid"
  | "provenance-invalid"
  | "sink-invalid"
  | "receipt-unavailable";

export class CanaryAttestationError extends Error {
  readonly code: CanaryAttestationErrorCode;

  constructor(code: CanaryAttestationErrorCode) {
    super(`Canary attestation failed closed (${code}).`);
    this.name = "CanaryAttestationError";
    this.code = code;
  }
}

type ArmedConfiguration = {
  readonly action: CanaryActionDefinition;
  readonly actionDescriptor: CanaryActionDescriptor;
  readonly challenge: string;
  readonly policyId: string;
  readonly receiptDir: string;
};

type AttestorRuntime = {
  readonly randomUuid: () => string;
};

const disabledAttestor: CanaryAttestor = {
  async record() {
    return "not-target";
  },
};

const invalidAttestor: CanaryAttestor = {
  async record() {
    throw new CanaryAttestationError("configuration-invalid");
  },
};

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
};

const hasCredentialSyntax = (value: string): boolean =>
  /(?:github_pat_|gh[pousr]_|sk-[a-z0-9_-]{8,}|xox[baprs]-|akia[a-z0-9]{12,})/iu.test(
    value,
  );

const parseConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): ArmedConfiguration | "disabled" | undefined => {
  const canaryKeys = Object.keys(environment).filter((key) =>
    key.startsWith("PI_SISYPHUS_CANARY_"),
  );
  if (canaryKeys.length === 0) return "disabled";
  if (
    canaryKeys.some(
      (key) => !(ARMING_KEYS as readonly string[]).includes(key),
    ) ||
    ARMING_KEYS.some((key) => environment[key] === undefined)
  ) {
    return undefined;
  }

  const mode = environment.PI_SISYPHUS_CANARY_MODE;
  const actionId = environment.PI_SISYPHUS_CANARY_ACTION;
  const challenge = environment.PI_SISYPHUS_CANARY_CHALLENGE;
  const receiptDir = environment.PI_SISYPHUS_CANARY_RECEIPT_DIR;
  const policyId = environment.PI_SISYPHUS_CANARY_POLICY_ID;
  const actionIndex = ACTION_DEFINITIONS.findIndex(({ id }) => id === actionId);
  if (
    mode !== MODE ||
    actionIndex < 0 ||
    !challenge ||
    !CHALLENGE_PATTERN.test(challenge) ||
    hasCredentialSyntax(challenge) ||
    !receiptDir ||
    !isAbsolute(receiptDir) ||
    hasControlCharacter(receiptDir) ||
    !policyId ||
    Buffer.byteLength(policyId) > MAX_POLICY_ID_BYTES ||
    hasControlCharacter(policyId) ||
    hasCredentialSyntax(policyId) ||
    !POLICY_ID_PATTERN.test(policyId)
  ) {
    return undefined;
  }
  const action = ACTION_DEFINITIONS[actionIndex];
  const actionDescriptor = canaryActionDescriptors[actionIndex];
  if (!action || !actionDescriptor) return undefined;
  return { action, actionDescriptor, challenge, policyId, receiptDir };
};

const expectedPayload = (
  action: CanaryActionDefinition,
): Readonly<Record<string, unknown>> => ({
  ...action.input,
  tool: action.tool,
  resourceScope: action.resourceScope,
});

const isTarget = (action: CanaryActionDefinition, input: TrustInput): boolean =>
  input.version === 1 &&
  input.subject === "tool-call" &&
  input.context.actor === "agent" &&
  isDeepStrictEqual(input.payload, expectedPayload(action));

const sameNode = (
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
): boolean => left.dev === right.dev && left.ino === right.ino;

const currentUserId = (): number => {
  if (typeof process.geteuid !== "function") {
    throw new CanaryAttestationError("sink-invalid");
  }
  return process.geteuid();
};

const secureDirectory = async (receiptDir: string): Promise<BigIntStats> => {
  try {
    const metadata = await lstat(receiptDir, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== BigInt(currentUserId()) ||
      (metadata.mode & MODE_BITS) !== BigInt(DIRECTORY_MODE)
    ) {
      throw new CanaryAttestationError("sink-invalid");
    }
    return metadata;
  } catch (error) {
    if (error instanceof CanaryAttestationError) throw error;
    throw new CanaryAttestationError("sink-invalid");
  }
};

const validateExistingReceipts = async (
  receiptDir: string,
  directory: BigIntStats,
): Promise<number> => {
  let count = 0;
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await opendir(receiptDir);
    for await (const entry of handle) {
      count += 1;
      if (count > MAX_RECEIPTS || !RECEIPT_NAME_PATTERN.test(entry.name)) {
        throw new CanaryAttestationError("sink-invalid");
      }
      const metadata = await lstat(join(receiptDir, entry.name), {
        bigint: true,
      });
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.uid !== BigInt(currentUserId()) ||
        metadata.dev !== directory.dev ||
        metadata.nlink !== 1n ||
        (metadata.mode & MODE_BITS) !== BigInt(RECEIPT_MODE) ||
        metadata.size > BigInt(MAX_RECEIPT_BYTES)
      ) {
        throw new CanaryAttestationError("sink-invalid");
      }
    }
    return count;
  } catch (error) {
    if (error instanceof CanaryAttestationError) throw error;
    throw new CanaryAttestationError("sink-invalid");
  } finally {
    try {
      await handle?.close();
    } catch {}
  }
};

const assertDirectoryIdentity = async (
  receiptDir: string,
  expected: BigIntStats,
): Promise<void> => {
  const observed = await secureDirectory(receiptDir);
  if (!sameNode(expected, observed)) {
    throw new CanaryAttestationError("sink-invalid");
  }
};

const syncDirectory = async (
  receiptDir: string,
  expected: BigIntStats,
): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      receiptDir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isDirectory() || !sameNode(metadata, expected)) {
      throw new CanaryAttestationError("sink-invalid");
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof CanaryAttestationError) throw error;
    throw new CanaryAttestationError("receipt-unavailable");
  } finally {
    try {
      await handle?.close();
    } catch {}
  }
};

const publishReceipt = async (
  receiptDir: string,
  contents: string,
  runtime: AttestorRuntime,
): Promise<void> => {
  if (Buffer.byteLength(contents) > MAX_RECEIPT_BYTES) {
    throw new CanaryAttestationError("receipt-unavailable");
  }
  const directory = await secureDirectory(receiptDir);
  if ((await validateExistingReceipts(receiptDir, directory)) >= MAX_RECEIPTS) {
    throw new CanaryAttestationError("sink-invalid");
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = runtime.randomUuid();
    if (!UUID_PATTERN.test(id)) {
      throw new CanaryAttestationError("receipt-unavailable");
    }
    const temporaryPath = join(receiptDir, `.${RECEIPT_PREFIX}${id}.tmp`);
    const finalPath = join(
      receiptDir,
      `${RECEIPT_PREFIX}${id}${RECEIPT_SUFFIX}`,
    );
    let temporary: FileHandle | undefined;
    let published = false;
    try {
      temporary = await open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        TEMPORARY_MODE,
      );
      await temporary.chmod(TEMPORARY_MODE);
      const opened = await temporary.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.uid !== BigInt(currentUserId()) ||
        opened.dev !== directory.dev ||
        opened.nlink !== 1n ||
        (opened.mode & MODE_BITS) !== BigInt(TEMPORARY_MODE)
      ) {
        throw new CanaryAttestationError("sink-invalid");
      }
      await temporary.writeFile(contents, "utf8");
      await temporary.sync();
      await temporary.chmod(RECEIPT_MODE);
      const sealed = await temporary.stat({ bigint: true });
      if (
        sealed.size !== BigInt(Buffer.byteLength(contents)) ||
        (sealed.mode & MODE_BITS) !== BigInt(RECEIPT_MODE)
      ) {
        throw new CanaryAttestationError("receipt-unavailable");
      }
      await assertDirectoryIdentity(receiptDir, directory);
      await link(temporaryPath, finalPath);
      published = true;
      const finalMetadata = await lstat(finalPath, { bigint: true });
      if (
        finalMetadata.isSymbolicLink() ||
        !finalMetadata.isFile() ||
        finalMetadata.uid !== BigInt(currentUserId()) ||
        finalMetadata.dev !== sealed.dev ||
        finalMetadata.ino !== sealed.ino ||
        finalMetadata.nlink !== 2n ||
        (finalMetadata.mode & MODE_BITS) !== BigInt(RECEIPT_MODE) ||
        finalMetadata.size !== sealed.size
      ) {
        throw new CanaryAttestationError("sink-invalid");
      }
      await temporary.close();
      temporary = undefined;
      await unlink(temporaryPath);
      await syncDirectory(receiptDir, directory);
      await assertDirectoryIdentity(receiptDir, directory);
      const durable = await lstat(finalPath, { bigint: true });
      if (durable.nlink !== 1n || !sameNode(durable, sealed)) {
        throw new CanaryAttestationError("sink-invalid");
      }
      return;
    } catch (error) {
      try {
        await temporary?.close();
      } catch {}
      temporary = undefined;
      await unlink(temporaryPath).catch(() => undefined);
      if (published) {
        throw new CanaryAttestationError("receipt-unavailable");
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (error instanceof CanaryAttestationError) throw error;
      throw new CanaryAttestationError("receipt-unavailable");
    } finally {
      try {
        await temporary?.close();
      } catch {}
    }
  }
  throw new CanaryAttestationError("receipt-unavailable");
};

const policyBinding = (
  evaluation: ProvenanceBoundTrustEvaluation,
): { readonly aggregateDigest: string } => {
  const binding = evaluation.binding;
  if (!binding || !DIGEST_PATTERN.test(binding.aggregateDigest)) {
    throw new CanaryAttestationError("provenance-invalid");
  }
  return binding;
};

const receiptFor = (
  configuration: ArmedConfiguration,
  evaluation: ProvenanceBoundTrustEvaluation,
): string => {
  if (
    (evaluation.ok && !DECISION_EFFECTS.has(evaluation.decision.effect)) ||
    (!evaluation.ok && !FAILURE_CODES.has(evaluation.code))
  ) {
    throw new CanaryAttestationError("receipt-unavailable");
  }
  const binding = policyBinding(evaluation);
  const identity = {
    contract: CONTRACT,
    contractVersion: 1,
    sourceVersion: 1,
    action: configuration.actionDescriptor,
    challenge: configuration.challenge,
    policy: {
      id: configuration.policyId,
      aggregateBundleDigest: binding.aggregateDigest,
    },
  } as const;
  return `${JSON.stringify(
    evaluation.ok
      ? {
          ...identity,
          result: "decision",
          effect: evaluation.decision.effect,
        }
      : { ...identity, result: "failure", code: evaluation.code },
  )}\n`;
};

const armedAttestor = (
  configuration: ArmedConfiguration,
  runtime: AttestorRuntime,
): CanaryAttestor => {
  let publication = Promise.resolve();
  return {
    async record(input, evaluation) {
      if (!isTarget(configuration.action, input)) return "not-target";
      const contents = receiptFor(configuration, evaluation);
      const current = publication.then(() =>
        publishReceipt(configuration.receiptDir, contents, runtime),
      );
      publication = current.catch(() => undefined);
      await current;
      return "recorded";
    },
  };
};

export const createCanaryAttestor = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtime: Partial<AttestorRuntime> = {},
): CanaryAttestor => {
  const configuration = parseConfiguration(environment);
  if (configuration === "disabled") return disabledAttestor;
  if (!configuration) return invalidAttestor;
  return armedAttestor(configuration, {
    randomUuid: runtime.randomUuid ?? randomUUID,
  });
};
