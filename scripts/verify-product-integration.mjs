#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runModelPicker } from "../packages/pi-model-picker/src/index.ts";
import { evaluateTrust, vetMcp } from "../packages/pi-sisyphus/src/index.ts";

const sisyphusBinary = process.env.PI_PRODUCT_SISYPHUS_BIN;
const modelPickerBinary = process.env.PI_PRODUCT_MODEL_PICKER_BIN;
if (!sisyphusBinary || !modelPickerBinary) {
  throw new Error(
    "PI_PRODUCT_SISYPHUS_BIN and PI_PRODUCT_MODEL_PICKER_BIN are required",
  );
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-product-integration-"));
try {
  const bundleDir = join(temporaryRoot, "bundle");
  await mkdir(bundleDir);
  const policy = `${JSON.stringify(
    {
      manifest: {
        id: "adapter-integration",
        revision: "1.0.0",
        roots: ["tool-call"],
      },
      rules: [
        {
          id: "allow-read",
          description: "Allow the integration read request",
          subject: "tool-call",
          matchers: [{ field: "tool", operator: "equals", value: "Read" }],
          effect: "allow",
          priority: 10,
        },
      ],
    },
    null,
    2,
  )}\n`;
  const policyDigest = sha256(policy);
  const bundleDigest = sha256(`policy.json\0${policyDigest}\n`);
  await writeFile(join(bundleDir, "policy.json"), policy, "utf8");
  await writeFile(
    join(bundleDir, "bundle.manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        revision: "adapter-integration",
        files: [{ path: "policy.json", sha256: policyDigest }],
        digest: bundleDigest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const trust = await evaluateTrust(
    {
      version: 1,
      requestId: "product-integration-read",
      subject: "tool-call",
      payload: { tool: "Read", path: "README.md", resourceScope: "workspace" },
      context: { cwd: process.cwd(), actor: "agent" },
    },
    {
      PI_SISYPHUS_BIN: resolve(sisyphusBinary),
      PI_SISYPHUS_BUNDLE_DIR: bundleDir,
      PI_SISYPHUS_BUNDLE_DIGEST: bundleDigest,
    },
  );
  if (!trust.ok || trust.decision.effect !== "allow") {
    throw new Error(
      "real Sisyphus evaluation did not allow the reviewed input",
    );
  }

  const vet = await vetMcp(
    {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/rpc",
      capabilities: {
        readOnly: true,
        filesystem: "none",
        network: "internet",
        secrets: false,
      },
      provenance: { package: "@example/docs", version: "1.2.3" },
    },
    { PI_SISYPHUS_BIN: resolve(sisyphusBinary) },
  );
  if (
    !vet.ok ||
    vet.evidence.advisoryEffect !== "allow" ||
    !vet.evidence.descriptorIdentity ||
    vet.evidence.server.endpoint !== "http:https://mcp.example.test"
  ) {
    throw new Error("real Sisyphus MCP evidence did not cross the adapter");
  }

  const selection = await runModelPicker(
    { task: "coding", limit: 2 },
    process.cwd(),
    resolve(modelPickerBinary),
  );
  if (
    !selection.ok ||
    selection.selection.contract !== "model-picker.selection" ||
    selection.selection.version !== 1 ||
    selection.selection.choices.length === 0
  ) {
    throw new Error("real model-picker selection did not cross the adapter");
  }
  console.log(
    "verify-product-integration: sy evaluation, MCP vet, model picker ok",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
