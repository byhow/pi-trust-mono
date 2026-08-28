import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type McpVetExecutor, vetMcp } from "./mcp.ts";

const descriptor = {
  name: "docs",
  transport: "http" as const,
  url: "https://mcp.example.test/rpc",
  headers: { Authorization: "secret-value" },
  capabilities: {
    readOnly: true,
    filesystem: "none" as const,
    network: "internet" as const,
    secrets: false,
  },
};

const evidence = (advisoryEffect: "allow" | "deny" | "ask") => {
  const server = {
    name: "docs",
    transport: "http",
    endpoint: "http:https://mcp.example.test",
    argumentShape: [],
    provenance: {},
    rootClassifications: [],
    capabilities: descriptor.capabilities,
  };
  const credentialKeys = ["Authorization"];
  return JSON.stringify({
    version: 1,
    subject: "mcp-connect",
    advisoryEffect,
    descriptorIdentity: JSON.stringify({ ...server, credentialKeys }),
    server,
    credentialKeys,
    findings:
      advisoryEffect === "allow"
        ? []
        : [
            {
              code: "review.required",
              severity: "medium",
              message: "Review this descriptor.",
            },
          ],
  });
};

type MutableEvidenceFixture = {
  descriptorIdentity: string;
  server: {
    argumentShape: unknown;
    capabilities: unknown;
    provenance: unknown;
    rootClassifications: unknown;
  };
};

const corruptEvidence = (
  change: (value: MutableEvidenceFixture) => void,
): string => {
  const value = JSON.parse(evidence("allow")) as MutableEvidenceFixture;
  change(value);
  return JSON.stringify(value);
};

describe("vetMcp", () => {
  test.each([
    ["allow", 0],
    ["deny", 1],
    ["ask", 1],
  ] as const)("accepts %s evidence from Sisyphus", async (effect, code) => {
    const execute: McpVetExecutor = vi.fn(async (binary, input) => {
      expect(binary).toBe("/opt/mist/bin/sy");
      expect(JSON.parse(input)).toEqual(descriptor);
      return { code, killed: false, stdout: evidence(effect) };
    });
    const result = await vetMcp(
      descriptor,
      { PI_SISYPHUS_BIN: "/opt/mist/bin/sy" },
      execute,
    );
    expect(result).toMatchObject({
      ok: true,
      evidence: { advisoryEffect: effect, credentialKeys: ["Authorization"] },
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  test("runs MCP vet through the real process boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-sisyphus-mcp-"));
    const binary = join(directory, "sy");
    await writeFile(
      binary,
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${evidence("allow")}'\n`,
      "utf8",
    );
    await chmod(binary, 0o755);
    expect(await vetMcp(descriptor, { PI_SISYPHUS_BIN: binary })).toMatchObject(
      { ok: true, evidence: { advisoryEffect: "allow" } },
    );
  });

  test("rejects invalid evidence", async () => {
    const execute: McpVetExecutor = async () => ({
      code: 0,
      killed: false,
      stdout: JSON.stringify({ advisoryEffect: "allow" }),
    });
    expect(
      await vetMcp(
        descriptor,
        { PI_SISYPHUS_BIN: "/opt/mist/bin/sy" },
        execute,
      ),
    ).toEqual({ ok: false, code: "engine-invalid" });
  });

  test("rejects malformed fields and mismatched exit codes", async () => {
    for (const [stdout, code] of [
      ["not-json", 0],
      [evidence("deny"), 0],
      [
        corruptEvidence((value) => {
          value.descriptorIdentity = "{}";
        }),
        0,
      ],
      [
        corruptEvidence((value) => {
          value.server.provenance = { sha256: "short" };
        }),
        0,
      ],
      [
        corruptEvidence((value) => {
          value.server.capabilities = { network: "world" };
        }),
        0,
      ],
      [
        corruptEvidence((value) => {
          value.server.rootClassifications = ["world"];
        }),
        0,
      ],
      [
        corruptEvidence((value) => {
          value.server.argumentShape = [42];
        }),
        0,
      ],
      [
        JSON.stringify({
          version: 1,
          subject: "mcp-connect",
          advisoryEffect: "allow",
          server: { name: "docs", transport: "http" },
          credentialKeys: [42],
          findings: [],
        }),
        0,
      ],
      [
        JSON.stringify({
          version: 1,
          subject: "mcp-connect",
          advisoryEffect: "allow",
          server: { name: "docs", transport: "http" },
          credentialKeys: [],
          findings: [{ code: "bad", severity: "unknown", message: "bad" }],
        }),
        0,
      ],
    ] as const) {
      const execute: McpVetExecutor = async () => ({
        code,
        killed: false,
        stdout,
      });
      expect(
        await vetMcp(
          descriptor,
          { PI_SISYPHUS_BIN: "/opt/mist/bin/sy" },
          execute,
        ),
      ).toEqual({ ok: false, code: "engine-invalid" });
    }
  });

  test("distinguishes unavailable engines from invalid configuration", async () => {
    const killed: McpVetExecutor = async () => ({
      code: -1,
      killed: true,
      stdout: "",
    });
    expect(
      await vetMcp(descriptor, { PI_SISYPHUS_BIN: "/opt/mist/bin/sy" }, killed),
    ).toEqual({ ok: false, code: "engine-unavailable" });

    const failed: McpVetExecutor = async () => {
      throw new Error("missing");
    };
    expect(
      await vetMcp(descriptor, { PI_SISYPHUS_BIN: "/opt/mist/bin/sy" }, failed),
    ).toEqual({ ok: false, code: "engine-unavailable" });

    const cyclic: Record<string, unknown> = { ...descriptor };
    cyclic.self = cyclic;
    expect(
      await vetMcp(
        cyclic as never,
        { PI_SISYPHUS_BIN: "/opt/mist/bin/sy" },
        vi.fn(),
      ),
    ).toEqual({ ok: false, code: "policy-config-invalid" });
  });

  test("requires the reviewed absolute launcher", async () => {
    const execute = vi.fn<McpVetExecutor>();
    expect(
      await vetMcp(descriptor, { PI_SISYPHUS_BIN: "sy" }, execute),
    ).toEqual({ ok: false, code: "policy-config-invalid" });
    expect(execute).not.toHaveBeenCalled();
  });
});
