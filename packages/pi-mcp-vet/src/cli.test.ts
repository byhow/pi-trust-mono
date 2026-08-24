import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type McpVetCliIO, runMcpVetCli } from "./cli.ts";

const io = (stdin = "") => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const port: McpVetCliIO = {
    readStdin: async () => stdin,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { port, stdout, stderr };
};

const allowed = JSON.stringify({
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/rpc",
});

describe("runMcpVetCli", () => {
  test("reads stdin and returns the policy exit code", async () => {
    const state = io(allowed);
    expect(await runMcpVetCli(["-"], state.port)).toBe(0);
    expect(JSON.parse(state.stdout.join(""))).toMatchObject({
      effect: "allow",
    });
    expect(state.stderr).toEqual([]);
  });

  test("reads a bounded regular descriptor file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-vet-cli-"));
    const path = join(directory, "server.json");
    await writeFile(path, allowed, "utf8");
    const state = io();
    expect(await runMcpVetCli([path], state.port)).toBe(0);
  });

  test("returns deny and ask exit codes", async () => {
    const denied = io(
      JSON.stringify({
        name: "remote",
        transport: "http",
        url: "http://example.test/rpc",
      }),
    );
    expect(await runMcpVetCli(["-"], denied.port)).toBe(1);

    const ask = io(
      JSON.stringify({
        name: "local",
        transport: "stdio",
        command: "node",
      }),
    );
    expect(await runMcpVetCli(["-"], ask.port)).toBe(2);
  });

  test("provides help and stable usage failures", async () => {
    const help = io();
    expect(await runMcpVetCli(["--help"], help.port)).toBe(0);
    expect(help.stdout.join("")).toContain("Usage:");

    const usage = io();
    expect(await runMcpVetCli([], usage.port)).toBe(64);
    expect(usage.stderr.join("")).toContain("Usage:");
  });

  test("does not echo malformed input", async () => {
    const state = io('{"token":"secret-value"');
    expect(await runMcpVetCli(["-"], state.port)).toBe(65);
    expect(state.stderr.join("")).not.toContain("secret-value");
  });
});
