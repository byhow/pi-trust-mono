export type TrustInput = {
  readonly version: 1;
  readonly requestId: string;
  readonly subject: "tool-call";
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly tool: string;
  };
  readonly context: {
    readonly cwd: string;
    readonly actor: "agent";
  };
};

export type TrustDecision = {
  readonly version: 1;
  readonly requestId?: string;
  readonly effect: "allow" | "deny" | "ask" | "modify";
  readonly reason: string;
  readonly modified?: Readonly<Record<string, unknown>>;
  readonly policy: {
    readonly bundle: string;
    readonly rule: string;
    readonly revision: string;
  };
};

export type TrustEvaluation =
  | { readonly ok: true; readonly decision: TrustDecision }
  | {
      readonly ok: false;
      readonly code:
        | "policy-config-invalid"
        | "engine-unavailable"
        | "engine-invalid";
    };

export type McpCapabilities = {
  readonly readOnly?: boolean;
  readonly filesystem?: "none" | "workspace" | "host";
  readonly network?: "none" | "loopback" | "internet";
  readonly secrets?: boolean;
};

export type McpProvenance = {
  readonly package?: string;
  readonly version?: string;
  readonly sha256?: string;
};

export type McpServerDescriptor = {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly roots?: readonly string[];
  readonly capabilities?: McpCapabilities;
  readonly provenance?: McpProvenance;
};

export type McpVetEvidence = {
  readonly version: 1;
  readonly subject: "mcp-connect";
  readonly advisoryEffect: "allow" | "deny" | "ask";
  readonly descriptorIdentity: string;
  readonly server: {
    readonly name: string;
    readonly transport: "stdio" | "http";
    readonly endpoint: string;
    readonly argumentShape: readonly string[];
    readonly provenance: McpProvenance;
    readonly rootClassifications: readonly ("workspace" | "host")[];
    readonly capabilities: McpCapabilities;
  };
  readonly credentialKeys: readonly string[];
  readonly findings: readonly {
    readonly code: string;
    readonly severity: "high" | "medium" | "low";
    readonly message: string;
  }[];
};

export type McpVetResult =
  | { readonly ok: true; readonly evidence: McpVetEvidence }
  | {
      readonly ok: false;
      readonly code:
        | "policy-config-invalid"
        | "engine-unavailable"
        | "engine-invalid";
    };
