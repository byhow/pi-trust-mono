import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { PolicyEngineExecutor, PolicyProcessResult } from "./engine.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

/** Spawn the reviewed local engine without a shell or persistent raw-input log. */
export const spawnPolicyEngine: PolicyEngineExecutor = (config, input) => {
  const { promise, resolve } = Promise.withResolvers<PolicyProcessResult>();
  const child = spawn(config.binary, ["evaluate", "-"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      HOME: tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: tmpdir(),
      TRUST_ENGINE_BUNDLE_DIR: config.bundleDir,
      TRUST_ENGINE_LOG_PATH: "/dev/null",
    },
  });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, 5_000);

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      killed = true;
      child.kill("SIGKILL");
    } else {
      stdout.push(chunk);
    }
  });
  child.stderr.resume();
  child.on("error", () => {
    clearTimeout(timer);
    resolve({ code: -1, killed: true, stdout: "" });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({
      code: code ?? -1,
      killed,
      stdout: Buffer.concat(stdout).toString("utf8"),
    });
  });
  child.stdin.end(input);
  return promise;
};
