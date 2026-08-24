export const selection = {
  contract: "model-picker.selection",
  version: 1,
  source: "snapshot",
  request: { task: "agent", agent: null, filter: null, limit: 1 },
  count: 1,
  choices: [
    {
      id: "provider/model",
      name: "Model",
      score: 0.75,
      reasons: ["balanced"],
      contextWindow: 128_000,
      outputPerMillion: 2,
      bestThroughput: 42,
    },
  ],
} as const;
