#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lintHarness } from "./lint.ts";

const MAX_INPUT_BYTES = 128 * 1024;
const HELP = "Usage: pi-harness-lint <harness.json|->";

export type HarnessLintCliIO = {
  readonly readStdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

const defaultIo: HarnessLintCliIO = {
  async readStdin() {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) throw new Error("input-too-large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  stdout(text) {
    process.stdout.write(text);
  },
  stderr(text) {
    process.stderr.write(text);
  },
};

const readFileBounded = async (path: string): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) {
      throw new Error("unsafe-input-file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

export const runHarnessLintCli = async (
  args: readonly string[],
  io: HarnessLintCliIO = defaultIo,
): Promise<number> => {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  const source = args[0];
  if (!source || args.length !== 1) {
    io.stderr(`${HELP}\n`);
    return 64;
  }

  try {
    const raw =
      source === "-"
        ? await io.readStdin()
        : await readFileBounded(resolve(source));
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES)
      throw new Error("input-too-large");
    const report = lintHarness(JSON.parse(raw));
    io.stdout(`${JSON.stringify(report)}\n`);
    if (report.findings.some((finding) => finding.severity === "error"))
      return 1;
    if (report.findings.some((finding) => finding.severity === "warning"))
      return 2;
    return 0;
  } catch {
    io.stderr("pi-harness-lint: descriptor input is invalid or unsafe\n");
    return 65;
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runHarnessLintCli(process.argv.slice(2));
}
