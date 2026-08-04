// Watchlist loader/writer. The list lives in `web/data/universe.json` so
// it can be edited by hand or refreshed by DeepSeek via the API route.
// Server-only — uses Node fs.
import fs from "node:fs";
import path from "node:path";

export interface UniverseEntry {
  symbol: string;
  name: string;
  theme: string;
  note?: string;
  /** Does the company sell into the global AI supply chain (NVIDIA, AMD,
   *  Apple, Google, hyperscalers) — vs. domestic-only revenue. */
  global_supply?: boolean;
}

export interface UniverseFile {
  $schema_note?: string;
  updated_at: string;
  updated_by: string;
  entries: UniverseEntry[];
}

const FILE = path.join(process.cwd(), "data", "universe.json");

export function readUniverse(): UniverseFile {
  const raw = fs.readFileSync(FILE, "utf-8");
  return JSON.parse(raw) as UniverseFile;
}

export function writeUniverse(file: UniverseFile): void {
  // Atomic write: temp file + rename so concurrent readers never see a
  // partially-written JSON. Requires a directory bind-mount for Docker
  // (compose mounts ./web/data → /app/data); a single-file bind of
  // universe.json makes rename fail or detach from the host inode.
  const tmp = FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist or already renamed */ }
    throw e;
  }
}

/** Convenience accessor for callers that only want the entries. */
export function loadEntries(): UniverseEntry[] {
  return readUniverse().entries;
}
