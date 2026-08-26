import { describe, expect, test, vi } from "vitest";
import {
  evaluatePolicy,
  type PolicyEngineExecutor,
  resolvePolicyEngineConfig,
} from "./engine.ts";
import type { PolicyInput } from "./types.ts";

const input: PolicyInput = {
  subject: "tool-call",
  payload: { tool: "Read", path: "README.md" },
  context: { cwd: "/workspace", actor: "agent" },
};

const decision = {
  effect: "allow",
  reason: "Read-only workspace access is allowed.",
  policy: { bundle: "baseline", rule: "allow-read", revision: "1.0.0" },
} as const;

const environment = {
  PATH: "/usr/bin:/bin",
  PI_TRUST_BUNDLE_DIR: "/opt/policy/bundles",
  PI_TRUST_ENGINE_BIN: "/opt/sisyphus/bin/sy",
};

describe("resolvePolicyEngineConfig", () => {
  test("requires an exact absolute engine and bundle path", () => {
    expect(resolvePolicyEngineConfig(environment)).toEqual({
      binary: "/opt/sisyphus/bin/sy",
      bundleDir: "/opt/policy/bundles",
    });
    expect(
      resolvePolicyEngineConfig({
        ...environment,
        PI_TRUST_ENGINE_BIN: "/opt/sisyphus/bin/sy",
      }),
    ).toEqual({
      binary: "/opt/sisyphus/bin/sy",
      bundleDir: "/opt/policy/bundles",
    });
  });

  test.each([
    {},
    { PI_TRUST_BUNDLE_DIR: "/opt/bundles" },
    {
      PI_TRUST_BUNDLE_DIR: "relative/bundles",
      PI_TRUST_ENGINE_BIN: "/opt/bin/sy",
    },
    {
      PI_TRUST_BUNDLE_DIR: "/opt/bundles",
      PI_TRUST_ENGINE_BIN: "relative/sy",
    },
    {
      PI_TRUST_BUNDLE_DIR: "/opt/bundles",
      PI_TRUST_ENGINE_BIN: "/opt/bin/node",
    },
  ])("rejects unsafe policy configuration %#", (value) => {
    expect(resolvePolicyEngineConfig(value)).toBeUndefined();
  });
});

describe("evaluatePolicy", () => {
  test("sends bounded JSON to the selected engine and accepts a valid decision", async () => {
    const execute: PolicyEngineExecutor = vi.fn(async () => ({
      code: 0,
      killed: false,
      stdout: JSON.stringify(decision),
    }));
    expect(await evaluatePolicy(input, environment, execute)).toEqual({
      ok: true,
      decision,
    });
    expect(execute).toHaveBeenCalledWith(
      { binary: "/opt/sisyphus/bin/sy", bundleDir: "/opt/policy/bundles" },
      JSON.stringify(input),
    );
  });

  test("accepts a valid deny decision despite the engine deny exit code", async () => {
    const denied = { ...decision, effect: "deny" as const };
    expect(
      await evaluatePolicy(input, environment, async () => ({
        code: 1,
        killed: false,
        stdout: JSON.stringify(denied),
      })),
    ).toEqual({ ok: true, decision: denied });
  });

  test("rejects killed and non-zero authorizing decisions", async () => {
    expect(
      await evaluatePolicy(input, environment, async () => ({
        code: 0,
        killed: true,
        stdout: JSON.stringify(decision),
      })),
    ).toEqual({ ok: false, code: "engine-unavailable" });
    expect(
      await evaluatePolicy(input, environment, async () => ({
        code: 1,
        killed: false,
        stdout: JSON.stringify(decision),
      })),
    ).toEqual({ ok: false, code: "engine-invalid" });
  });

  test.each([
    "not-json",
    JSON.stringify({ ...decision, effect: "unknown" }),
    JSON.stringify({ ...decision, reason: "" }),
    JSON.stringify({ ...decision, policy: { bundle: "x" } }),
    JSON.stringify({ ...decision, effect: "modify" }),
    '{"effect":"modify","reason":"rewrite","policy":{"bundle":"baseline","rule":"rewrite","revision":"1.0.0"},"modified":{"__proto__":"unsafe"}}',
  ])("rejects invalid policy output %#", async (stdout) => {
    expect(
      await evaluatePolicy(input, environment, async () => ({
        code: 0,
        killed: false,
        stdout,
      })),
    ).toEqual({ ok: false, code: "engine-invalid" });
  });

  test("fails closed when the engine is unavailable or throws", async () => {
    expect(
      await evaluatePolicy(input, environment, async () => ({
        code: -1,
        killed: true,
        stdout: "",
      })),
    ).toEqual({ ok: false, code: "engine-unavailable" });
    expect(
      await evaluatePolicy(input, environment, async () => {
        throw new Error("unavailable");
      }),
    ).toEqual({ ok: false, code: "engine-unavailable" });
  });

  test("rejects forbidden override fields before invoking the engine", async () => {
    const execute = vi.fn<PolicyEngineExecutor>();
    expect(
      await evaluatePolicy(
        {
          ...input,
          payload: { tool: "Bash", __effect__: "allow" },
        },
        environment,
        execute,
      ),
    ).toEqual({ ok: false, code: "policy-config-invalid" });
    expect(execute).not.toHaveBeenCalled();
  });
});
