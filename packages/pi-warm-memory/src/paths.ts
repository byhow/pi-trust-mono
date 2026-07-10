/**
 * Shared history-directory resolution for pi-warm-memory commands.
 *
 * The history dir holds `index.jsonl` (durable, append-only) + `packets/YYYY/MM/`.
 * Resolution order: `PI_WARM_HISTORY_DIR` (absolute, or relative to cwd), else the
 * project-local default `.pi/history`. Kept in sync with the manifest
 * `pi.settings.historyDir` fallback.
 */
import { isAbsolute, resolve } from "node:path";

/** Default history location, relative to the project root. */
export const DEFAULT_HISTORY_DIR = ".pi/history";

/** Env override for the history directory (see package.json → pi.settings.historyDir.env). */
export const HISTORY_DIR_ENV = "PI_WARM_HISTORY_DIR";

export const resolveHistoryDir = (cwd: string): string => {
  const configured = process.env[HISTORY_DIR_ENV];
  if (configured)
    return isAbsolute(configured) ? configured : resolve(cwd, configured);
  return resolve(cwd, DEFAULT_HISTORY_DIR);
};
