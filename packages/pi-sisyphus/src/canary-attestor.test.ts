import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  canaryActionDescriptors,
  createCanaryAttestor,
} from "./canary-attestor.ts";
import type { ProvenanceBoundTrustEvaluation } from "./engine.ts";
import type { TrustInput } from "./types.ts";

const input: TrustInput = {
  version: 1,
  requestId: "call-1",
  subject: "tool-call",
  payload: {
    path: "README.md",
    tool: "Read",
    resourceScope: "workspace",
  },
  context: { cwd: "/worktree", actor: "agent" },
};

const evaluation: ProvenanceBoundTrustEvaluation = {
  ok: true,
  decision: {
    version: 1,
    requestId: "call-1",
    effect: "allow",
    reason: "reviewed",
    policy: {
      bundle: "policy-read-only",
      rule: "read",
      revision: "1",
    },
  },
  binding: { aggregateDigest: "a".repeat(64) },
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true })),
  );
});

const armedEnvironment = async (
  overrides: Readonly<Record<string, string | undefined>> = {},
) => {
  const receiptDir = await mkdtemp(join(tmpdir(), "pi-sisyphus-canary-"));
  temporaryDirectories.push(receiptDir);
  await chmod(receiptDir, 0o700);
  return {
    PI_SISYPHUS_CANARY_MODE: "fleet-lab-v1",
    PI_SISYPHUS_CANARY_ACTION: "read-only-scout",
    PI_SISYPHUS_CANARY_CHALLENGE: "c".repeat(43),
    PI_SISYPHUS_CANARY_RECEIPT_DIR: receiptDir,
    PI_SISYPHUS_CANARY_POLICY_ID: "sisyphus://bundle/v1",
    ...overrides,
  };
};

const receiptFiles = async (receiptDir: string) =>
  (await readdir(receiptDir)).filter((name) => name.endsWith(".json"));

describe("createCanaryAttestor", () => {
  test("is inert when canary attestation is not armed", async () => {
    const attestor = await createCanaryAttestor({});

    await expect(attestor.record(input, evaluation)).resolves.toBe(
      "not-target",
    );
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: false,
      }),
    ).resolves.toBe("not-pending");
    expect(() => attestor.shutdown()).not.toThrow();
  });

  test("durably records a closed decision attestation for an exact target", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await expect(attestor.record(input, evaluation)).resolves.toBe("recorded");

    const names = await readdir(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^attestation-[0-9a-f-]{36}\.json$/u);
    const path = join(
      environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      names[0] ?? "missing",
    );
    const receipt = JSON.parse(await readFile(path, "utf8"));
    expect(receipt).toEqual({
      contract: "zoysia.fleet-lab.sisyphus-attestation",
      contractVersion: 1,
      sourceVersion: 1,
      action: canaryActionDescriptors.find(
        ({ id }) => id === "read-only-scout",
      ),
      challenge: "c".repeat(43),
      policy: {
        id: "sisyphus://bundle/v1",
        aggregateBundleDigest: "a".repeat(64),
      },
      result: "decision",
      effect: "allow",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o400);
  });

  test("publishes a stable closed registry and matching public catalog", async () => {
    expect(canaryActionDescriptors.map(({ id }) => id)).toEqual([
      "normalize-slug",
      "read-only-scout",
      "denied-action",
      "worker-interruption",
      "coordinator-restart",
    ]);
    expect(
      new Set(
        canaryActionDescriptors.map(({ definitionDigest }) => definitionDigest),
      ).size,
    ).toBe(canaryActionDescriptors.length);
    expect(Object.isFrozen(canaryActionDescriptors)).toBe(true);
    for (const descriptor of canaryActionDescriptors) {
      expect(descriptor).toMatchObject({ definitionVersion: 1 });
      expect(descriptor.definitionDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
    const catalog = JSON.parse(
      await readFile(
        new URL("../canary-actions.json", import.meta.url),
        "utf8",
      ),
    );
    expect(catalog).toMatchObject({
      contract: "pi-sisyphus.canary-actions",
      contractVersion: 1,
      digestAlgorithm: "sha256",
      canonicalization: "json-stringify-ordered-v1",
    });
    const descriptors = catalog.actions.map(
      ({ definitionDigest, ...definition }: Record<string, unknown>) => {
        expect(
          createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        ).toBe(definitionDigest);
        return {
          id: definition.id,
          definitionVersion: definition.definitionVersion,
          definitionDigest,
        };
      },
    );
    expect(descriptors).toEqual(canaryActionDescriptors);
  });

  test.each([
    { PI_SISYPHUS_CANARY_MODE: undefined },
    { PI_SISYPHUS_CANARY_MODE: "fleet-lab-v2" },
    { PI_SISYPHUS_CANARY_ACTION: "caller-defined" },
    { PI_SISYPHUS_CANARY_CHALLENGE: "short" },
    { PI_SISYPHUS_CANARY_CHALLENGE: `sk-${"a".repeat(40)}` },
    { PI_SISYPHUS_CANARY_RECEIPT_DIR: "relative" },
    { PI_SISYPHUS_CANARY_RECEIPT_DIR: "/private/path\nredirected" },
    { PI_SISYPHUS_CANARY_POLICY_ID: "bundle-v1" },
    {
      PI_SISYPHUS_CANARY_POLICY_ID: `sisyphus://bundle/${"a".repeat(129)}`,
    },
    { PI_SISYPHUS_CANARY_POLICY_ID: "sisyphus://bundle/v1\nredirected" },
    { PI_SISYPHUS_CANARY_UNREVIEWED: "present" },
  ])("fails closed for partial or malformed arming: %j", async (override) => {
    const environment = await armedEnvironment(override);
    const attestor = createCanaryAttestor(environment);

    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "configuration-invalid",
    });
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: false,
      }),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
    expect(() => attestor.shutdown()).not.toThrow();
  });

  test("rejects credential-shaped policy identities before publication", async () => {
    const credentialShapedPolicyId = `sisyphus://bundle/sk-${"a".repeat(40)}`;
    const environment = await armedEnvironment({
      PI_SISYPHUS_CANARY_POLICY_ID: credentialShapedPolicyId,
    });
    const attestor = createCanaryAttestor(environment);

    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "configuration-invalid",
    });
    expect(
      await readdir(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(0);
  });

  test("matches exact normalized values independent of key order and cwd", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);
    const reordered: TrustInput = {
      ...input,
      payload: {
        resourceScope: "workspace",
        tool: "Read",
        path: "README.md",
      },
      context: { ...input.context, cwd: "/another/worktree" },
    };

    await expect(attestor.record(reordered, evaluation)).resolves.toBe(
      "recorded",
    );
  });

  test.each([
    { path: "OTHER.md", tool: "Read", resourceScope: "workspace" },
    { path: "README.md", tool: "read", resourceScope: "workspace" },
    { path: "README.md", tool: "Read", resourceScope: "external" },
    {
      path: "README.md",
      tool: "Read",
      resourceScope: "workspace",
      extra: true,
    },
    {
      path: "sensitive-private-value-must-never-be-digested",
      tool: "Read",
      resourceScope: "workspace",
    },
  ])("does not attest a near match: %j", async (payload) => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await expect(
      attestor.record({ ...input, payload }, evaluation),
    ).resolves.toBe("not-target");
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(0);
  });

  test("requires the exact TrustInput envelope as well as its payload", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);
    for (const changed of [
      { ...input, version: 2 },
      { ...input, subject: "diagnostic" },
      { ...input, context: { ...input.context, actor: "operator" } },
    ]) {
      await expect(attestor.record(changed as never, evaluation)).resolves.toBe(
        "not-target",
      );
    }
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(0);
  });

  test.each(["deny", "ask", "modify"] as const)(
    "records %s without policy reasons or rewritten input",
    async (effect) => {
      const environment = await armedEnvironment();
      const attestor = createCanaryAttestor(environment);
      const changed: ProvenanceBoundTrustEvaluation = {
        ...evaluation,
        decision: {
          ...evaluation.decision,
          effect,
          reason: "sensitive-private-policy-context",
          ...(effect === "modify"
            ? { modified: { path: "private-file" } }
            : {}),
        },
      };

      await attestor.record(input, changed);
      await expect(
        attestor.complete({
          toolCallId: input.requestId,
          toolName: "read",
          isError: false,
        }),
      ).resolves.toBe("not-pending");
      const [name] = await receiptFiles(
        environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      );
      const raw = await readFile(
        join(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR, name ?? "missing"),
        "utf8",
      );
      expect(JSON.parse(raw)).toMatchObject({ result: "decision", effect });
      for (const forbidden of [
        "requestId",
        "tool",
        "input",
        "path",
        "cwd",
        "reason",
        "modified",
        "credential",
        "requestDigest",
      ]) {
        expect(raw).not.toContain(`"${forbidden}"`);
      }
      expect(raw).not.toContain("sensitive-private-policy-context");
      expect(raw).not.toContain("private-file");
    },
  );

  test.each([
    "policy-config-invalid",
    "engine-unavailable",
    "engine-invalid",
  ] as const)(
    "records the closed %s failure with actual bundle provenance",
    async (code) => {
      const environment = await armedEnvironment();
      const attestor = createCanaryAttestor(environment);
      const failure: ProvenanceBoundTrustEvaluation = {
        ok: false,
        code,
        binding: { aggregateDigest: "b".repeat(64) },
      };

      await attestor.record(input, failure);
      await expect(
        attestor.complete({
          toolCallId: input.requestId,
          toolName: "read",
          isError: false,
        }),
      ).resolves.toBe("not-pending");
      const [name] = await receiptFiles(
        environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      );
      const receipt = JSON.parse(
        await readFile(
          join(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR, name ?? "missing"),
          "utf8",
        ),
      );
      expect(receipt).toMatchObject({
        result: "failure",
        code,
        policy: { aggregateBundleDigest: "b".repeat(64) },
      });
      expect(receipt).not.toHaveProperty("effect");
    },
  );

  test("refuses to invent aggregate provenance for an unbound result", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);
    const unbound: ProvenanceBoundTrustEvaluation = {
      ok: false,
      code: "policy-config-invalid",
    };

    await expect(attestor.record(input, unbound)).rejects.toMatchObject({
      code: "provenance-invalid",
    });
    await expect(
      attestor.record(input, {
        ...evaluation,
        binding: { aggregateDigest: "not-a-digest" },
      }),
    ).rejects.toMatchObject({ code: "provenance-invalid" });
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(0);
  });

  test("rejects outcomes outside the closed receipt variants", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await expect(
      attestor.record(input, {
        ...evaluation,
        decision: { ...evaluation.decision, effect: "future-effect" },
      } as never),
    ).rejects.toMatchObject({ code: "receipt-unavailable" });
    await expect(
      attestor.record(input, {
        ok: false,
        code: "future-failure",
        binding: evaluation.binding,
      } as never),
    ).rejects.toMatchObject({ code: "receipt-unavailable" });
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(0);
  });

  test("fails closed when an allowed tool-call identifier is reused", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await attestor.record(input, evaluation);
    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "receipt-unavailable",
    });

    const names = await receiptFiles(
      environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
    );
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^attestation-/u);
  });

  test("does not reuse an identifier first recorded for a blocked decision", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);
    const denied: ProvenanceBoundTrustEvaluation = {
      ...evaluation,
      decision: { ...evaluation.decision, effect: "deny" },
    };

    await attestor.record(input, denied);
    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "receipt-unavailable",
    });
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(1);
  });

  test("records one closed error-or-cancellation outcome and retires it", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await attestor.record(input, evaluation);
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: true,
      }),
    ).resolves.toBe("recorded");
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: false,
      }),
    ).resolves.toBe("not-pending");
    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "receipt-unavailable",
    });

    const names = await receiptFiles(
      environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
    );
    expect(names).toHaveLength(2);
    const completionName = names.find((name) => name.startsWith("completion-"));
    const completionPath = join(
      environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      completionName ?? "missing",
    );
    expect(JSON.parse(await readFile(completionPath, "utf8"))).toMatchObject({
      contract: "zoysia.fleet-lab.sisyphus-completion",
      contractVersion: 1,
      outcome: "tool-error-or-cancelled",
    });
    expect((await stat(completionPath)).mode & 0o777).toBe(0o400);
  });

  test.each([
    { toolName: "write", isError: false },
    { toolName: "Read", isError: false },
    { toolName: "read", isError: undefined },
  ])(
    "retires a mismatched or ambiguous result without minting: %j",
    async (result) => {
      const environment = await armedEnvironment();
      const attestor = createCanaryAttestor(environment);

      await attestor.record(input, evaluation);
      await expect(
        attestor.complete({ toolCallId: input.requestId, ...result }),
      ).resolves.toBe("retired");
      await expect(
        attestor.complete({
          toolCallId: input.requestId,
          toolName: "read",
          isError: false,
        }),
      ).resolves.toBe("not-pending");
      expect(
        await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
      ).toHaveLength(1);
    },
  );

  test("clears pending state on shutdown without claiming completion", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await attestor.record(input, evaluation);
    attestor.shutdown();
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: false,
      }),
    ).resolves.toBe("not-pending");
    await expect(
      attestor.record(
        { ...input, requestId: "call-after-shutdown" },
        evaluation,
      ),
    ).rejects.toMatchObject({ code: "receipt-unavailable" });
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(1);
  });

  test("retires the pending result when completion publication fails", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);

    await attestor.record(input, evaluation);
    await chmod(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR, 0o755);
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: false,
      }),
    ).rejects.toMatchObject({ code: "sink-invalid" });
    await expect(
      attestor.complete({
        toolCallId: input.requestId,
        toolName: "read",
        isError: false,
      }),
    ).resolves.toBe("not-pending");
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(1);
  });

  test("bounds pending correlations and completes each accepted identifier once", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment);
    const accepted = Array.from({ length: 16 }, (_, index) => `call-${index}`);

    for (const requestId of accepted) {
      await attestor.record(
        { ...input, requestId },
        {
          ...evaluation,
          decision: { ...evaluation.decision, requestId },
        },
      );
    }
    const overflowId = "call-overflow";
    await expect(
      attestor.record(
        { ...input, requestId: overflowId },
        {
          ...evaluation,
          decision: { ...evaluation.decision, requestId: overflowId },
        },
      ),
    ).rejects.toMatchObject({ code: "receipt-unavailable" });

    for (const toolCallId of accepted) {
      await expect(
        attestor.complete({ toolCallId, toolName: "read", isError: false }),
      ).resolves.toBe("recorded");
    }
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(32);
  });

  test("serializes concurrent publications so the receipt cap cannot race", async () => {
    const environment = await armedEnvironment();
    for (let index = 0; index < 31; index += 1) {
      await writeFile(
        join(
          environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
          `attestation-${randomUUID()}.json`,
        ),
        "{}\n",
        { mode: 0o400 },
      );
    }
    const attestor = createCanaryAttestor(environment);

    const results = await Promise.allSettled([
      attestor.record(input, evaluation),
      attestor.record(input, evaluation),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(32);
  });

  test("binds each trial to its own challenge without replay state", async () => {
    const firstEnvironment = await armedEnvironment();
    const secondEnvironment = await armedEnvironment({
      PI_SISYPHUS_CANARY_CHALLENGE: "d".repeat(43),
    });

    await createCanaryAttestor(firstEnvironment).record(input, evaluation);
    await createCanaryAttestor(secondEnvironment).record(input, evaluation);

    const readChallenge = async (
      environment: Awaited<ReturnType<typeof armedEnvironment>>,
    ) => {
      const [name] = await receiptFiles(
        environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      );
      const receipt = JSON.parse(
        await readFile(
          join(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR, name ?? "missing"),
          "utf8",
        ),
      );
      return receipt.challenge;
    };
    await expect(readChallenge(firstEnvironment)).resolves.toBe("c".repeat(43));
    await expect(readChallenge(secondEnvironment)).resolves.toBe(
      "d".repeat(43),
    );
  });

  test("never overwrites a colliding receipt name", async () => {
    const environment = await armedEnvironment();
    const collision = "00000000-0000-4000-8000-000000000001";
    const replacement = "00000000-0000-4000-8000-000000000002";
    const existing = join(
      environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      `attestation-${collision}.json`,
    );
    await writeFile(existing, "existing\n", { mode: 0o400 });
    const ids = [collision, replacement];
    const attestor = createCanaryAttestor(environment, {
      randomUuid: () => ids.shift() ?? replacement,
    });

    await expect(attestor.record(input, evaluation)).resolves.toBe("recorded");
    expect(await readFile(existing, "utf8")).toBe("existing\n");
    expect(
      await receiptFiles(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(2);
  });

  test("fails closed after bounded collision retries", async () => {
    const environment = await armedEnvironment();
    const collision = "00000000-0000-4000-8000-000000000003";
    const existing = join(
      environment.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      `attestation-${collision}.json`,
    );
    await writeFile(existing, "existing\n", { mode: 0o400 });
    const attestor = createCanaryAttestor(environment, {
      randomUuid: () => collision,
    });

    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "receipt-unavailable",
    });
    expect(await readFile(existing, "utf8")).toBe("existing\n");
    expect(await readdir(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR)).toEqual([
      `attestation-${collision}.json`,
    ]);
  });

  test("rejects an invalid receipt identifier without creating output", async () => {
    const environment = await armedEnvironment();
    const attestor = createCanaryAttestor(environment, {
      randomUuid: () => "not-a-uuid",
    });

    await expect(attestor.record(input, evaluation)).rejects.toMatchObject({
      code: "receipt-unavailable",
    });
    expect(
      await readdir(environment.PI_SISYPHUS_CANARY_RECEIPT_DIR),
    ).toHaveLength(0);
  });

  test("rejects insecure, symlinked, contaminated, and full sinks", async () => {
    const insecure = await armedEnvironment();
    await chmod(insecure.PI_SISYPHUS_CANARY_RECEIPT_DIR, 0o755);
    await expect(
      createCanaryAttestor(insecure).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const linked = await armedEnvironment();
    const linkedTarget = join(linked.PI_SISYPHUS_CANARY_RECEIPT_DIR, "private");
    const linkedPath = join(linked.PI_SISYPHUS_CANARY_RECEIPT_DIR, "linked");
    await mkdir(linkedTarget, { mode: 0o700 });
    await symlink(linkedTarget, linkedPath);
    await expect(
      createCanaryAttestor({
        ...linked,
        PI_SISYPHUS_CANARY_RECEIPT_DIR: linkedPath,
      }).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const contaminated = await armedEnvironment();
    await writeFile(
      join(contaminated.PI_SISYPHUS_CANARY_RECEIPT_DIR, "unexpected"),
      "unexpected",
    );
    await expect(
      createCanaryAttestor(contaminated).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const linkedEntry = await armedEnvironment();
    const linkedEntryTarget = join(
      linkedEntry.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      "target",
    );
    await writeFile(linkedEntryTarget, "{}\n", { mode: 0o400 });
    await symlink(
      linkedEntryTarget,
      join(
        linkedEntry.PI_SISYPHUS_CANARY_RECEIPT_DIR,
        `attestation-${randomUUID()}.json`,
      ),
    );
    await expect(
      createCanaryAttestor(linkedEntry).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const mutableEntry = await armedEnvironment();
    await writeFile(
      join(
        mutableEntry.PI_SISYPHUS_CANARY_RECEIPT_DIR,
        `attestation-${randomUUID()}.json`,
      ),
      "{}\n",
      { mode: 0o600 },
    );
    await expect(
      createCanaryAttestor(mutableEntry).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const oversizedEntry = await armedEnvironment();
    await writeFile(
      join(
        oversizedEntry.PI_SISYPHUS_CANARY_RECEIPT_DIR,
        `attestation-${randomUUID()}.json`,
      ),
      "x".repeat(4 * 1024 + 1),
      { mode: 0o400 },
    );
    await expect(
      createCanaryAttestor(oversizedEntry).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const linkedInode = await armedEnvironment();
    const firstLink = join(
      linkedInode.PI_SISYPHUS_CANARY_RECEIPT_DIR,
      `attestation-${randomUUID()}.json`,
    );
    await writeFile(firstLink, "{}\n", { mode: 0o400 });
    await link(
      firstLink,
      join(
        linkedInode.PI_SISYPHUS_CANARY_RECEIPT_DIR,
        `attestation-${randomUUID()}.json`,
      ),
    );
    await expect(
      createCanaryAttestor(linkedInode).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });

    const full = await armedEnvironment();
    for (let index = 0; index < 33; index += 1) {
      await writeFile(
        join(
          full.PI_SISYPHUS_CANARY_RECEIPT_DIR,
          `attestation-${randomUUID()}.json`,
        ),
        "{}\n",
        { mode: 0o400 },
      );
    }
    await expect(
      createCanaryAttestor(full).record(input, evaluation),
    ).rejects.toMatchObject({ code: "sink-invalid" });
  });
});
