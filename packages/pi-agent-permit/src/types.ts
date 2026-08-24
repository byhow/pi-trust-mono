export type PolicyInput = {
  readonly subject: "tool-call";
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly tool: string;
  };
  readonly context: {
    readonly cwd: string;
    readonly actor: "agent" | "user";
  };
};

export type PolicyDecision = {
  readonly effect: "allow" | "deny" | "ask" | "modify";
  readonly reason: string;
  readonly modified?: Readonly<Record<string, unknown>>;
  readonly policy: {
    readonly bundle: string;
    readonly rule: string;
    readonly revision: string;
  };
};

export type PolicyEvaluation =
  | { readonly ok: true; readonly decision: PolicyDecision }
  | {
      readonly ok: false;
      readonly code:
        | "engine-invalid"
        | "engine-unavailable"
        | "policy-config-invalid";
    };
