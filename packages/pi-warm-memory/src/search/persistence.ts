/**
 * Persist an Orama index to disk as JSON. The path is injected by the caller, so
 * this module is storage-location agnostic. The index is a disposable cache; a
 * corrupted or missing file just triggers a rebuild upstream.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnyOrama } from "@orama/orama";
import { load, save } from "@orama/orama";

/** Persist the index. Atomic write (tmp + rename) to avoid partial-write corruption. */
export const saveIndex = async (
  db: AnyOrama,
  indexPath: string,
): Promise<string> => {
  await mkdir(dirname(indexPath), { recursive: true });
  const data = await save(db);
  const tmpPath = `${indexPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data), "utf8");
  await rename(tmpPath, indexPath);
  return indexPath;
};

export type LoadResult =
  | { readonly loaded: true }
  | { readonly loaded: false; readonly reason: "not-found" | "corrupted" };

/** Load a previously saved index into `db`. Never throws — reports why it failed. */
export const loadIndex = async (
  db: AnyOrama,
  indexPath: string,
): Promise<LoadResult> => {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    return { loaded: false, reason: "not-found" };
  }

  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) {
      return { loaded: false, reason: "corrupted" };
    }
    await load(db, data as Parameters<typeof load>[1]);
    return { loaded: true };
  } catch {
    return { loaded: false, reason: "corrupted" };
  }
};
