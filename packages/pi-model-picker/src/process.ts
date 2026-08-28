import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
const SYSTEM_PATH = "/usr/bin:/bin";

export type ModelPickerProcessResult = {
  readonly code: number;
  readonly killed: boolean;
  readonly stdout: string;
};
export type ModelPickerProcessOptions = {
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
};

export type ModelPickerExecutor = (
  binary: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  options?: ModelPickerProcessOptions,
) => Promise<ModelPickerProcessResult>;

export const spawnModelPicker: ModelPickerExecutor = async (
  binary,
  args,
  cwd,
  signal,
  options = {},
) => {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-model-picker-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(binary, [...args], {
        cwd,
        detached: process.platform !== "win32",
        env: {
          PATH: SYSTEM_PATH,
          HOME: privateRoot,
          TMPDIR: privateRoot,
          XDG_CACHE_HOME: privateRoot,
          XDG_CONFIG_HOME: privateRoot,
          XDG_DATA_HOME: privateRoot,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let killed = false;
      let settled = false;
      const finish = (result: ModelPickerProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
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
      const timeout = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          abort();
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
      if (signal?.aborted) abort();
    });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
};
