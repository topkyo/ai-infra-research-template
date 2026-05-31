import fs from "node:fs";
import path from "node:path";

const serverDir = path.join(process.cwd(), ".next", "server");
const chunksDir = path.join(serverDir, "chunks");
const runtimePath = path.join(serverDir, "webpack-runtime.js");

if (!fs.existsSync(runtimePath) || !fs.existsSync(chunksDir)) {
  process.exit(0);
}

const runtime = fs.readFileSync(runtimePath, "utf8");
const rootChunkRequirePattern = /require\(\s*["']\.\/["']\s*\+\s*(?:__webpack_require__|[A-Za-z_$][\w$]*)\.u\(\s*(?:chunkId|[A-Za-z_$][\w$]*)\s*\)\s*\)/;
const loadsChunksFromServerRoot = rootChunkRequirePattern.test(runtime);
const chunkFiles = fs
  .readdirSync(chunksDir)
  .filter((name) => /^\d+\.js(?:\.map)?$/.test(name));

if (!loadsChunksFromServerRoot || chunkFiles.length === 0) {
  process.exit(0);
}

for (const name of chunkFiles) {
  const source = path.join(chunksDir, name);
  const target = path.join(serverDir, name);
  fs.copyFileSync(source, target);
}

const missing = chunkFiles
  .filter((name) => /^\d+\.js$/.test(name))
  .filter((name) => !fs.existsSync(path.join(serverDir, name)));

if (missing.length > 0) {
  throw new Error(`Missing server runtime chunks: ${missing.join(", ")}`);
}

console.log("Patched Next server runtime chunks for next start");
