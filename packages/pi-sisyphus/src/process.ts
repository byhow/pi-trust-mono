import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

export type SisyphusProcessResult = {
  readonly code: number;
  readonly killed: boolean;
  readonly stdout: string;
};

export const spawnSisyphus = async (
  binary: string,
  args: readonly string[],
  input: string,
  environment: Readonly<Record<string, string>>,
): Promise<SisyphusProcessResult> =>
  new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      env: { PATH: process.env.PATH ?? "", ...environment },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let killed = false;
    let settled = false;

    const finish = (result: SisyphusProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        killed = true;
        child.kill("SIGKILL");
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
    child.stdin.on("error", () => {
      killed = true;
      child.kill("SIGKILL");
    });
    child.stdin.end(input);
  });
