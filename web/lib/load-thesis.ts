import fs from "node:fs";
import path from "node:path";

function dataDir(): string {
  return path.join(process.cwd(), "data");
}

export function loadThesisNarrative(): string {
  const local = path.join(dataDir(), "thesis.md");
  const example = path.join(dataDir(), "thesis.example.md");
  if (fs.existsSync(local)) {
    const text = fs.readFileSync(local, "utf-8").trim();
    if (text) return text;
  }
  if (fs.existsSync(example)) {
    const text = fs.readFileSync(example, "utf-8").trim();
    if (text) return text;
  }
  throw new Error("missing web/data/thesis.example.md");
}
