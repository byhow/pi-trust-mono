import type {
  CustomCommand,
  CustomCommandAPI,
  CustomCommandFactory,
} from "@oh-my-pi/pi-coding-agent";
import { HELP, runRecall } from "./recall-core.ts";

/**
 * `/recall` command — a thin adapter over the pure `runRecall` logic in
 * recall-core.ts. All ranking/formatting/validation lives there (and is unit
 * tested); this file only wires the pi command surface to `ctx.cwd`.
 */
const createCommand = (_api: CustomCommandAPI): CustomCommand => ({
  name: "recall",
  description:
    "Search prior handoff/checkpoint packets and surface the most relevant to continue from. " +
    HELP,
  execute: (args, ctx) => runRecall(args, ctx.cwd),
});

const recallFactory: CustomCommandFactory = (api) => createCommand(api);

export default recallFactory satisfies CustomCommandFactory;
