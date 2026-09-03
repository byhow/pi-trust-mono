import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  evaluateTrust,
  evaluateTrustWithProvenance,
  resolveSisyphusConfig,
  type TrustExecutor,
} from "./engine.ts";
import type { TrustInput } from "./types.ts";

const environment = {
  PI_SISYPHUS_BIN: "/opt/mist/bin/sy",
  PI_SISYPHUS_BUNDLE_DIR: "/nix/store/reviewed-policy",
  PI_SISYPHUS_BUNDLE_DIGEST: "a".repeat(64),
  PI_SISYPHUS_DECISION_LOG: "/private/decisions.jsonl",
};
const binding = { aggregateDigest: "a".repeat(64) };

const input: TrustInput = {
  version: 1,
  requestId: "call-1",
  subject: "tool-call",
  payload: { tool: "Read", path: "README.md" },
  context: { cwd: "/work", actor: "agent" },
};

const decision = (
  effect: "allow" | "deny" | "ask" | "modify",
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    version: 1,
    requestId: "call-1",
    effect,
    reason: `${effect} reason`,
    policy: { bundle: "safe", rule: effect, revision: "1" },
    ...extra,
  });

describe("resolveSisyphusConfig", () => {
  test("accepts reviewed absolute paths and digest", () => {
    expect(resolveSisyphusConfig(environment)).toEqual({
      binary: "/opt/mist/bin/sy",
      bundleDir: "/nix/store/reviewed-policy",
      bundleDigest: "a".repeat(64),
      decisionLog: "/private/decisions.jsonl",
    });
  });

  test.each([
    { ...environment, PI_SISYPHUS_BIN: "sy" },
    { ...environment, PI_SISYPHUS_BIN: "/opt/mist/bin/not-sy" },
    { ...environment, PI_SISYPHUS_BUNDLE_DIR: "relative" },
    { ...environment, PI_SISYPHUS_BUNDLE_DIGEST: "short" },
    { ...environment, PI_SISYPHUS_DECISION_LOG: "relative" },
  ])("rejects unsafe configuration", (value) => {
    expect(resolveSisyphusConfig(value)).toBeUndefined();
  });
});

describe("evaluateTrust", () => {
  test("preserves the exact public result shape when canary support is unarmed", async () => {
    const execute: TrustExecutor = async () => ({
      code: 0,
      killed: false,
      stdout: decision("allow"),
    });

    await expect(evaluateTrust(input, environment, execute)).resolves.toEqual({
      ok: true,
      decision: JSON.parse(decision("allow")),
    });

    await expect(
      evaluateTrust(input, environment, async () => {
        throw new Error("unavailable");
      }),
    ).resolves.toEqual({ ok: false, code: "engine-unavailable" });
  });

  test("keeps canary arming out of the existing engine configuration boundary", async () => {
    const execute: TrustExecutor = vi.fn(async (config) => {
      expect(config).toEqual({
        binary: environment.PI_SISYPHUS_BIN,
        bundleDir: environment.PI_SISYPHUS_BUNDLE_DIR,
        bundleDigest: environment.PI_SISYPHUS_BUNDLE_DIGEST,
        decisionLog: environment.PI_SISYPHUS_DECISION_LOG,
      });
      return { code: 0, killed: false, stdout: decision("allow") };
    });

    await expect(
      evaluateTrust(
        input,
        {
          ...environment,
          PI_SISYPHUS_CANARY_MODE: "fleet-lab-v1",
          PI_SISYPHUS_CANARY_ACTION: "read-only-scout",
        },
        execute,
      ),
    ).resolves.toEqual({
      ok: true,
      decision: JSON.parse(decision("allow")),
    });
  });

  test.each([
    ["allow", 0],
    ["deny", 1],
    ["ask", 2],
    ["modify", 3],
  ] as const)(
    "accepts %s only with its exact exit code",
    async (effect, code) => {
      const execute: TrustExecutor = vi.fn(async (_config, raw) => {
        expect(JSON.parse(raw)).toEqual(input);
        return {
          code,
          killed: false,
          stdout: decision(
            effect,
            effect === "modify" ? { modified: { path: "SAFE.md" } } : {},
          ),
        };
      });
      expect(await evaluateTrust(input, environment, execute)).toMatchObject({
        ok: true,
        decision: { effect },
      });
    },
  );

  test("rejects mismatched request ids", async () => {
    const execute: TrustExecutor = async () => ({
      code: 0,
      killed: false,
      stdout: decision("allow", { requestId: "another-call" }),
    });
    expect(await evaluateTrust(input, environment, execute)).toEqual({
      ok: false,
      code: "engine-invalid",
    });
  });

  test("rejects mismatched exit codes", async () => {
    const execute: TrustExecutor = async () => ({
      code: 0,
      killed: false,
      stdout: decision("deny"),
    });
    expect(await evaluateTrust(input, environment, execute)).toEqual({
      ok: false,
      code: "engine-invalid",
    });
  });

  test("fails closed for unavailable engines", async () => {
    const execute: TrustExecutor = async () => {
      throw new Error("missing");
    };
    expect(await evaluateTrust(input, environment, execute)).toEqual({
      ok: false,
      code: "engine-unavailable",
    });
  });

  test("runs the reviewed launcher through the real process boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-sisyphus-"));
    const binary = join(directory, "sy");
    await writeFile(
      binary,
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${decision("allow")}'\n`,
      "utf8",
    );
    await chmod(binary, 0o755);
    expect(
      await evaluateTrust(input, {
        PI_SISYPHUS_BIN: binary,
        PI_SISYPHUS_BUNDLE_DIR: "/reviewed/bundle",
        PI_SISYPHUS_BUNDLE_DIGEST: "a".repeat(64),
      }),
    ).toMatchObject({ ok: true, decision: { effect: "allow" } });
  });

  test("treats killed processes and malformed decisions as engine failures", async () => {
    const killed: TrustExecutor = async () => ({
      code: -1,
      killed: true,
      stdout: "",
    });
    expect(await evaluateTrust(input, environment, killed)).toEqual({
      ok: false,
      code: "engine-unavailable",
    });

    for (const stdout of [
      "not-json",
      JSON.stringify({ version: 0, effect: "allow" }),
      JSON.stringify({
        version: 1,
        requestId: "call-1",
        effect: "allow",
        reason: "missing policy",
      }),
      decision("modify"),
    ]) {
      const invalid: TrustExecutor = async () => ({
        code: 0,
        killed: false,
        stdout,
      });
      expect(await evaluateTrust(input, environment, invalid)).toEqual({
        ok: false,
        code: "engine-invalid",
      });
    }
  });

  test("rejects oversized policy input before launch", async () => {
    const execute = vi.fn<TrustExecutor>();
    expect(
      await evaluateTrust(
        { ...input, payload: { tool: "Read", value: "x".repeat(70_000) } },
        environment,
        execute,
      ),
    ).toEqual({ ok: false, code: "policy-config-invalid" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects cyclic policy input before launch", async () => {
    const payload: Record<string, unknown> = { tool: "Read" };
    payload.self = payload;
    const execute = vi.fn<TrustExecutor>();
    expect(
      await evaluateTrust(
        { ...input, payload } as TrustInput,
        environment,
        execute,
      ),
    ).toEqual({ ok: false, code: "policy-config-invalid" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("keeps aggregate bundle provenance on the private evaluation path", async () => {
    const execute: TrustExecutor = async () => ({
      code: 0,
      killed: false,
      stdout: decision("allow"),
    });

    await expect(
      evaluateTrustWithProvenance(input, environment, execute),
    ).resolves.toEqual({
      ok: true,
      decision: JSON.parse(decision("allow")),
      binding,
    });
  });
});
