import { describe, expect, test } from "vitest";
import { parseMcpDescriptor, vetMcpServer } from "./vet.ts";

const httpsServer = {
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/rpc",
  capabilities: {
    readOnly: true,
    filesystem: "none",
    network: "internet",
    secrets: false,
  },
} as const;

describe("parseMcpDescriptor", () => {
  test("normalizes a bounded descriptor without copying absent fields", () => {
    expect(parseMcpDescriptor(httpsServer)).toEqual({
      ok: true,
      value: httpsServer,
    });
  });

  test.each([
    null,
    [],
    {},
    { ...httpsServer, transport: "socket" },
    { ...httpsServer, command: "node" },
    { name: "stdio", transport: "stdio", args: [] },
    { name: "http", transport: "http", url: "https://x", args: ["bad"] },
    { ...httpsServer, env: { KEY: 42 } },
    { ...httpsServer, capabilities: { filesystem: "world" } },
    { ...httpsServer, provenance: { sha256: "short" } },
  ])("fails closed for malformed descriptor %#", (value) => {
    const result = parseMcpDescriptor(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.decision.effect).toBe("deny");
  });
});

describe("vetMcpServer", () => {
  test("allows a constrained HTTPS descriptor", () => {
    expect(vetMcpServer(httpsServer)).toMatchObject({
      effect: "allow",
      score: 100,
      findings: [],
      server: { name: "docs", transport: "http" },
    });
  });

  test("denies remote HTTP and embedded credentials without disclosing them", () => {
    const decision = vetMcpServer({
      ...httpsServer,
      url: "http://user:very-secret@example.test/rpc",
    });
    expect(decision.effect).toBe("deny");
    expect(decision.findings.map((finding) => finding.code)).toEqual([
      "transport.url-credentials",
      "transport.insecure-remote",
    ]);
    expect(JSON.stringify(decision)).not.toContain("very-secret");
  });

  test("requires review for loopback HTTP", () => {
    expect(
      vetMcpServer({ ...httpsServer, url: "http://127.0.0.1:3000/rpc" }),
    ).toMatchObject({
      effect: "ask",
      findings: [{ code: "transport.loopback-http" }],
    });
  });

  test("denies shell evaluation and unpinned package runners", () => {
    const shell = vetMcpServer({
      name: "shell",
      transport: "stdio",
      command: "/bin/bash",
      args: ["-c", "node server.js"],
      provenance: { version: "1.0.0" },
    });
    expect(shell.effect).toBe("deny");
    expect(shell.findings.map((finding) => finding.code)).toContain(
      "stdio.shell-eval",
    );

    const packageRunner = vetMcpServer({
      name: "package",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@example/mcp@latest"],
    });
    expect(packageRunner.effect).toBe("deny");
    expect(packageRunner.findings.map((finding) => finding.code)).toContain(
      "provenance.package-unpinned",
    );
  });

  test("allows an exactly pinned package runner", () => {
    expect(
      vetMcpServer({
        name: "package",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@example/mcp@1.2.3"],
        capabilities: { readOnly: true },
      }),
    ).toMatchObject({ effect: "allow", score: 100 });
  });

  test("asks for mutable PATH, credential, and mutating capabilities", () => {
    const decision = vetMcpServer({
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_TOKEN: "not-returned" },
      capabilities: { readOnly: false, filesystem: "workspace" },
    });
    expect(decision.effect).toBe("ask");
    expect(decision.findings.map((finding) => finding.code)).toEqual([
      "provenance.path-mutable",
      "credential.exposure-declared",
      "capability.mutating",
    ]);
    expect(JSON.stringify(decision)).not.toContain("not-returned");
  });

  test("denies broad roots and toxic capability combinations", () => {
    const decision = vetMcpServer({
      ...httpsServer,
      roots: ["$HOME"],
      capabilities: {
        readOnly: false,
        filesystem: "host",
        network: "internet",
        secrets: true,
      },
    });
    expect(decision.effect).toBe("deny");
    expect(decision.score).toBe(20);
    expect(decision.findings.map((finding) => finding.code)).toEqual([
      "filesystem.root-overbroad",
      "capability.toxic-combination",
    ]);
  });

  test("requires provenance for absolute binaries", () => {
    expect(
      vetMcpServer({
        name: "binary",
        transport: "stdio",
        command: "/opt/mcp/bin/server",
      }),
    ).toMatchObject({
      effect: "ask",
      findings: [{ code: "provenance.unverified-binary" }],
    });
  });
});
