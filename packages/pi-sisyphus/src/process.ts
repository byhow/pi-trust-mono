import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const SYSTEM_PATH = "/usr/bin:/bin";

export type SisyphusProcessResult = {
  readonly code: number;
  readonly killed: boolean;
  readonly stdout: string;
};

export type SisyphusProcessOptions = {
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
};

export const spawnSisyphus = async (
  binary: string,
  args: readonly string[],
  input: string,
  environment: Readonly<Record<string, string>>,
  options: SisyphusProcessOptions = {},
): Promise<SisyphusProcessResult> => {
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-sisyphus-"));
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await new Promise((resolve) => {
      const child = spawn(binary, [...args], {
        cwd: privateRoot,
        detached: process.platform !== "win32",
        env: {
          ...environment,
          PATH: SYSTEM_PATH,
          HOME: privateRoot,
          TMPDIR: privateRoot,
          XDG_CACHE_HOME: privateRoot,
          XDG_CONFIG_HOME: privateRoot,
          XDG_DATA_HOME: privateRoot,
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let killed = false;
      let settled = false;
      const killProcessTree = () => {
        killed = true;
        if (child.pid !== undefined && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // The group may have exited between observation and the signal.
          }
        }
        child.kill("SIGKILL");
      };

      const finish = (result: SisyphusProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(killProcessTree, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          killProcessTree();
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => finish({ code: -1, killed: true, stdout: "" }));
      child.on("close", (code) =>
        finish({
          code: code ?? -1,
          killed,
          stdout: killed ? "" : Buffer.concat(chunks).toString("utf8"),
        }),
      );
      child.stdin.on("error", killProcessTree);
      child.stdin.end(input);
    });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
};
