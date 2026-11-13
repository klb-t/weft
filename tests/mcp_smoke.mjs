import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "weft-mcp-"));
const control = path.join(dir, "control.json");
const child = spawn(process.execPath, [path.join(root, "mcp", "server.mjs")], {
  cwd: root,
  env: { ...process.env, WEFT_FAKE: "1", WEFT_CONTROL_FILE: control, WEFT_BIN: path.join(root, "build", "weft") },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const waiter = pending.shift();
    if (waiter) waiter(JSON.parse(line));
  }
});
function rpc(method, params, id) {
  const msg = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  if (id == null) {
    child.stdin.write(JSON.stringify(msg) + "\n");
    return Promise.resolve();
  }
  msg.id = id;
  return new Promise((resolve) => {
    pending.push(resolve);
    child.stdin.write(JSON.stringify(msg) + "\n");
  });
}
function fail(message) {
  console.error(message);
  child.kill("SIGTERM");
  process.exit(1);
}
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }, 1);
if (init.result?.serverInfo?.name !== "weft") fail("initialize " + JSON.stringify(init));
await rpc("notifications/initialized", {});
const listed = await rpc("tools/list", {}, 2);
const names = (listed.result?.tools || []).map((t) => t.name).sort();
if (names.join(",") !== "weft_act,weft_close,weft_open,weft_pending,weft_snapshot") fail("tools " + names.join(","));
const opened = await rpc("tools/call", { name: "weft_open", arguments: { url: "https://example.com/login" } }, 3);
const openedBody = opened.result?.structuredContent;
if (openedBody?.effect !== "allow" || !openedBody.snapshot?.has_password_field) fail("open " + JSON.stringify(opened));
const typed = await rpc("tools/call", { name: "weft_act", arguments: { op: "type", ref: "pw", text: "hunter2" } }, 4);
if (typed.result?.structuredContent?.rule_id !== "secret_in_payload" || JSON.stringify(typed).includes("hunter2") && typed.result.structuredContent.effect !== "deny") {
  fail("secret was not refused " + JSON.stringify(typed.result?.structuredContent));
}
if (JSON.stringify(typed.result).includes("hunter2")) fail("secret echoed to the model");
const help = await rpc("tools/call", { name: "weft_act", arguments: { op: "click", ref: "e1" } }, 5);
if (help.result?.structuredContent?.effect !== "allow") fail("help click " + JSON.stringify(help.result?.structuredContent));
const waiting = rpc("tools/call", { name: "weft_act", arguments: { op: "click", ref: "go" } }, 6);
let controlBody;
for (let i = 0; i < 30; i++) {
  try {
    controlBody = JSON.parse(await readFile(control, "utf8"));
    if (controlBody.pending?.id) break;
  } catch {
    /* not written yet */
  }
  await new Promise((r) => setTimeout(r, 50));
}
if (!controlBody?.pending?.id) fail("no approval was published");
const approved = await fetch(`http://127.0.0.1:${controlBody.port}/approval`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-weft-token": controlBody.token },
  body: JSON.stringify({ id: controlBody.pending.id, decision: "allow" }),
});
if (approved.status !== 204) fail("approve status " + approved.status);
const done = await waiting;
if (done.result?.structuredContent?.effect !== "allow" || done.result.structuredContent.approved_by !== "person") {
  fail("approved act " + JSON.stringify(done.result?.structuredContent));
}
const closed = await rpc("tools/call", { name: "weft_close", arguments: {} }, 7);
if (!closed.result?.structuredContent?.closed) fail("close " + JSON.stringify(closed.result?.structuredContent));
child.kill("SIGTERM");
await rm(dir, { recursive: true, force: true });
console.log("ok mcp");
