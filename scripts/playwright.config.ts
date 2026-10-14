import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

export default defineConfig({
  testDir: "./tests",
  outputDir: "../generated-artifacts/zipy-test-results",
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:80",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined,
    },
  },
});
