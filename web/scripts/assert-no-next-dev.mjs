import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  process.exit(0);
}

const projectDir = fs.realpathSync(process.cwd());
const nextBin = path.join(projectDir, "node_modules", ".bin", "next");
const currentPid = String(process.pid);

let psOutput = "";
try {
  psOutput = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
} catch {
  process.exit(0);
}

function readProcessCwd(pid) {
  if (process.platform === "linux") {
    try {
      return fs.realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  try {
    const output = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = output.split("\n").find((item) => item.startsWith("n"));
    return line ? fs.realpathSync(line.slice(1)) : null;
  } catch {
    return null;
  }
}

function isProjectProcess(processInfo) {
  const cwd = readProcessCwd(processInfo.pid);
  return cwd === projectDir;
}

function isNextDevCommand(command) {
  const normalized = command.replace(nextBin, "next");
  return (
    /(?:^|\s)next\s+dev(?:\s|$)/.test(normalized) ||
    /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev(?:\s|$)/.test(normalized)
  );
}

const devProcesses = psOutput
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const match = line.match(/^(\d+)\s+(.+)$/);
    return match ? { pid: match[1], command: match[2] } : null;
  })
  .filter((processInfo) => processInfo && processInfo.pid !== currentPid)
  .filter((processInfo) => isNextDevCommand(processInfo.command) && isProjectProcess(processInfo));

if (devProcesses.length > 0) {
  console.error("Refusing to run next build while next dev is running in this workspace.");
  console.error("Stop the dev server first: dev and build share .next and can corrupt runtime chunks.");
  for (const processInfo of devProcesses) {
    console.error(`  pid ${processInfo.pid}: ${processInfo.command}`);
  }
  process.exit(1);
}
