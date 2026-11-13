// The only desktop fork: where the Chromium binary lives, and the one flag
// that means "no window". The DevTools session after launch is the same.
import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const linuxNames = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next name */
    }
  }
  return candidates[0];
}

export function resolveChrome() {
  if (process.env.WEFT_CHROME) return process.env.WEFT_CHROME;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "";
    return firstExisting([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      local,
    ].filter(Boolean));
  }
  if (process.platform === "darwin") {
    return firstExisting(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]);
  }
  return firstExisting(linuxNames);
}

export function launchChrome({ port, userDataDir, headed }) {
  const executable = resolveChrome();
  const shell = path.basename(executable).includes("headless-shell");
  const args = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
  ];
  if (!headed && !shell) args.push("--headless=new");
  args.push("about:blank");
  return spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
}
