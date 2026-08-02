import { defineConfig } from "@playwright/test";

// E2E smoke tests run against a local stack: pyserver in deterministic MOCK
// mode (TUSHARE_TOKEN=mock) + the Next.js dev server on a dedicated port.
// Uses the system Chrome because Playwright's bundled chromium does not
// support macOS 12.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    channel: "chrome",
    headless: true,
    navigationTimeout: 60_000,
  },
  webServer: [
    {
      // `python -m uvicorn`: the .venv script shebangs may point at stale paths.
      command: "uv run python -m uvicorn main:app --port 8101",
      cwd: "../pyserver",
      env: {
        TUSHARE_TOKEN: "mock",
        PYSERVER_CACHE_DB: "/tmp/topkyo-e2e-cache.db",
      },
      port: 8101,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --port 3100",
      env: {
        PYSERVER_URL: "http://127.0.0.1:8101",
      },
      port: 3100,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
