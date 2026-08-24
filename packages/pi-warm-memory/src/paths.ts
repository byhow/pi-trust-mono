import { isAbsolute, parse, relative, resolve } from "node:path";
import { hasControlCharacter } from "./text-safety.ts";

/** Default private history location, relative to the project root. */
export const DEFAULT_HISTORY_DIR = ".pi/history";

/** Environment variable observed by both Pi and OMP adapters. */
export const HISTORY_DIR_ENV = "PI_WARM_HISTORY_DIR";

/** Explicit opt-in for users who want Git to track packet files. */
export const ALLOW_GIT_TRACKING_ENV = "PI_WARM_ALLOW_GIT_TRACKING";

export type HistoryLocation = {
  readonly path: string;
  readonly projectRoot: string;
  readonly projectScoped: boolean;
};

export class InvalidHistoryPathError extends Error {
  constructor() {
    super("The configured warm-memory history path is unsafe.");
    this.name = "InvalidHistoryPathError";
  }
}

const isWithin = (parent: string, child: string): boolean => {
  const fromParent = relative(parent, child);
  return (
    fromParent !== "" && !fromParent.startsWith("..") && !isAbsolute(fromParent)
  );
};

/**
 * Resolve host configuration without touching process state or the filesystem.
 * Relative locations must remain below the project root; absolute locations are
 * an explicit operator choice and are validated again by the archive store.
 */
export const resolveHistoryLocation = (
  cwd: string,
  configuredHistoryDir: string | undefined,
): HistoryLocation => {
  if (!cwd || hasControlCharacter(cwd)) throw new InvalidHistoryPathError();

  const projectRoot = resolve(cwd);
  const configured = configuredHistoryDir || DEFAULT_HISTORY_DIR;
  if (hasControlCharacter(configured)) throw new InvalidHistoryPathError();

  const projectScoped = !isAbsolute(configured);
  const path = resolve(projectRoot, configured);
  if (path === parse(path).root) throw new InvalidHistoryPathError();
  if (projectScoped && !isWithin(projectRoot, path)) {
    throw new InvalidHistoryPathError();
  }

  return { path, projectRoot, projectScoped };
};

export const allowsGitTracking = (value: string | undefined): boolean =>
  value === "1" || value?.toLowerCase() === "true";
