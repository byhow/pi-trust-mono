export type McpTransport = "stdio" | "http";

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
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly roots?: readonly string[];
  readonly capabilities?: McpCapabilities;
  readonly provenance?: McpProvenance;
};

export type McpVetSeverity = "high" | "medium" | "low";

export type McpVetFinding = {
  readonly code: string;
  readonly severity: McpVetSeverity;
  readonly message: string;
};

export type McpVetDecision = {
  readonly version: 1;
  readonly subject: "mcp-connect";
  readonly effect: "allow" | "deny" | "ask";
  readonly score: number;
  readonly server: {
    readonly name: string;
    readonly transport: McpTransport;
  };
  readonly findings: readonly McpVetFinding[];
};

export type McpDescriptorParseResult =
  | { readonly ok: true; readonly value: McpServerDescriptor }
  | { readonly ok: false; readonly decision: McpVetDecision };
