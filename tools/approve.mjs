// The person answers a waiting login. Not an MCP tool, so the model cannot call it.
//   node tools/approve.mjs allow
//   node tools/approve.mjs deny
//   node tools/approve.mjs allow --vault-text-file ./secret.txt
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function controlPath() {
  if (process.env.WEFT_CONTROL_FILE) return process.env.WEFT_CONTROL_FILE;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "weft", "control.json");
  }
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".local", "share");
  return path.join(base, "weft", "control.json");
}

const decision = process.argv[2];
if (decision !== "allow" && decision !== "deny") {
  console.error("usage: node tools/approve.mjs allow|deny [--vault-text-file path]");
  process.exit(2);
}
let vaultText = "";
const flag = process.argv.indexOf("--vault-text-file");
if (flag >= 0) vaultText = await readFile(process.argv[flag + 1], "utf8");
const control = JSON.parse(await readFile(controlPath(), "utf8"));
if (!control.pending?.id) {
  console.error("nothing is waiting");
  process.exit(1);
}
const res = await fetch(`http://127.0.0.1:${control.port}/approval`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-weft-token": control.token },
  body: JSON.stringify({ id: control.pending.id, decision, vault_text: vaultText || undefined }),
});
if (!res.ok && res.status !== 204) {
  console.error("approval failed: " + res.status);
  process.exit(1);
}
console.log(decision + " " + control.pending.id);
