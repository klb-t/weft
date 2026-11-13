// MCP stdio server. Loom's tool source kind "mcp" (protocol 2025-06-18) spawns this.
// kernel/loom/src/tool_sources/mcp.cpp opens a new process for every tools/list and tools/call,
// so this process is only a shim. The browser and libweft live in a detached daemon
// (`node mcp/server.mjs --daemon`) that later calls attach to.
// Policy decisions are the C++ `weft serve` process. This file only moves bytes.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { openSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { timingSafeEqual, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CdpSession } from "../hosts/cdp/driver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packPath = process.env.WEFT_PACK || path.join(root, "data", "runtime", "weft.pack");
const bin = process.env.WEFT_BIN || path.join(root, "build", "weft");

function controlPath() {
  if (process.env.WEFT_CONTROL_FILE) return process.env.WEFT_CONTROL_FILE;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "weft", "control.json");
  }
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".local", "share");
  return path.join(base, "weft", "control.json");
}

function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

class Engine {
  constructor() {
    this.child = spawn(bin, ["serve", "--pack", packPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.waiters = [];
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const waiter = this.waiters.shift();
        if (!waiter) continue;
        try {
          waiter.resolve(JSON.parse(line));
        } catch (err) {
          waiter.reject(err);
        }
      }
    });
    this.child.on("exit", (code) => {
      for (const waiter of this.waiters) waiter.reject(new Error("weft serve exited " + code));
      this.waiters = [];
    });
  }
  call(cmd) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(cmd) + "\n");
    });
  }
  close() {
    this.child.stdin.end();
  }
}

class FakeHost {
  constructor() {
    this.url = "about:blank";
    this.clicked = [];
    this.filled = [];
  }
  async open() {}
  async navigate(url) {
    this.url = url;
    return this.snapshot();
  }
  async snapshot() {
    const login = /login|oauth|sign-?in/i.test(this.url);
    const elements = [
      { ref: "e1", role: "link", name: "Help", tag: "a", type: "", autocomplete: "", secret: false },
    ];
    if (login) {
      elements.unshift(
        { ref: "pw", role: "textbox", name: "Hasło", tag: "input", type: "password", autocomplete: "current-password", secret: true },
        { ref: "go", role: "button", name: "Zaloguj się", tag: "button", type: "submit", autocomplete: "", secret: false },
      );
    }
    return {
      schema: "loom.weft.snapshot/1",
      url: this.url,
      title: "fake",
      elements,
      has_password_field: login,
      has_payment_field: false,
      permission_prompt: false,
    };
  }
  async act(action) {
    if (action.op === "navigate") return this.navigate(action.url);
    if ((action.op === "type" || action.op === "fill") && action.ref === "pw") {
      return { ok: false, error: "secret_refused_by_page" };
    }
    this.clicked.push(action.op + ":" + (action.ref || ""));
    return { ok: true };
  }
  async fillTrusted(ref) {
    this.filled.push(ref);
    return { ok: true, echoed: false };
  }
  async close() {}
}

function publicSnapshot(snapshot) {
  return {
    schema: snapshot.schema,
    url: snapshot.url,
    title: snapshot.title,
    has_password_field: snapshot.has_password_field,
    has_payment_field: snapshot.has_payment_field,
    permission_prompt: snapshot.permission_prompt,
    elements: (snapshot.elements || []).map((el) => ({
      ref: el.ref,
      role: el.role,
      name: el.name,
      tag: el.tag,
      type: el.type,
      secret: !!el.secret,
      value_preview: el.secret ? undefined : el.value_preview,
    })),
  };
}

const tools = [
  {
    name: "weft_open",
    title: "Open a page",
    description: "Open http(s) in the shared Chromium session. You and the person see the same page. Do not put passwords in the address.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "weft_snapshot",
    title: "Read the page",
    description: "Interactive elements of the current page. Secret field values are never included.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "weft_act",
    title: "Act on the page",
    description:
      "Click, type, scroll or navigate. Do not send passwords, cards, OTPs or tokens. If the effect is approve, stop and wait: the person approves on their side. There is no tool that grants the approval.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string" },
        ref: { type: "string" },
        text: { type: "string" },
        url: { type: "string" },
        key: { type: "string" },
        dy: { type: "number" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "weft_pending",
    title: "See a waiting approval",
    description: "Read-only. Lists a login or permission the person has not answered. Cannot approve it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "weft_close",
    title: "Close the session",
    description: "Close the shared browser session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
];

function toolResult(structured, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError,
  };
}

const state = {
  engine: null,
  host: null,
  pack: null,
  token: randomBytes(24).toString("hex"),
  port: 0,
  pending: null,
  waiters: new Map(),
  gestures: 0,
  lastGesture: 0,
};

async function publish() {
  const file = controlPath();
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify(
    {
      schema: "loom.weft.control/1",
      port: state.port,
      token: state.token,
      pending: state.pending,
    },
    null,
    2,
  );
  await writeFile(file, body, { mode: 0o600 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let callChain = Promise.resolve();
function enqueue(fn) {
  const run = callChain.then(fn, fn);
  callChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function withLock(fn) {
  const lockPath = controlPath() + ".lock";
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  for (let i = 0; i < 80; i++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!handle) throw new Error("weft daemon lock is held");
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function probe(control) {
  const res = await fetch(`http://127.0.0.1:${control.port}/health`, {
    headers: { "x-weft-token": control.token },
  });
  return res.ok;
}

async function ensureDaemon() {
  return withLock(async () => {
    try {
      const control = JSON.parse(await readFile(controlPath(), "utf8"));
      if (await probe(control)) return control;
    } catch {
      /* start one */
    }
    const logPath = path.join(path.dirname(controlPath()), "daemon.log");
    await mkdir(path.dirname(logPath), { recursive: true });
    const log = openSync(logPath, "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--daemon"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 200; i++) {
      await sleep(100);
      try {
        const control = JSON.parse(await readFile(controlPath(), "utf8"));
        if (await probe(control)) return control;
      } catch {
        /* not up yet */
      }
    }
    const logText = await readFile(logPath, "utf8").catch(() => "");
    throw new Error("weft daemon did not start\n" + logText.slice(-2000));
  });
}

async function callDaemon(name, args) {
  const control = await ensureDaemon();
  const res = await fetch(`http://127.0.0.1:${control.port}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-weft-token": control.token },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!res.ok) throw new Error("daemon call failed: " + res.status);
  return res.json();
}

function humanActive() {
  const windowMs = state.pack?.defaults?.preempt_ms ?? 400;
  return Date.now() - state.lastGesture < windowMs;
}

async function submit(action) {
  const snapshot = await state.host.snapshot();
  const response = await state.engine.call({
    cmd: "submit",
    request: { actor: "agent", human_active: humanActive(), snapshot, action },
  });
  if (!response.ok) return toolResult({ error: response.error }, true);
  const result = response.result;
  const decision = result.decision;
  if (decision.effect === "allow") {
    const performed = await state.host.act(action);
    const after = await state.host.snapshot();
    return toolResult({ effect: "allow", rule_id: decision.rule_id, reason: decision.reason, performed, snapshot: publicSnapshot(after) });
  }
  if (decision.effect !== "approve") {
    return toolResult({ effect: decision.effect, rule_id: decision.rule_id, reason: decision.reason, snapshot: publicSnapshot(snapshot) }, decision.effect === "deny");
  }
  state.pending = result.pending;
  await publish();
  const timeout = state.pack?.defaults?.approval_timeout_ms ?? 120000;
  let answer;
  try {
    answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("approval_timeout")), timeout);
      state.waiters.set(result.approval_id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  } catch (err) {
    state.pending = null;
    await publish();
    return toolResult({ effect: "deny", rule_id: "approval_timeout", reason: { en: "The person did not answer in time.", pl: "Osoba nie odpowiedziała na czas." } }, true);
  }
  state.pending = null;
  await publish();
  if (answer.decision !== "allow") {
    return toolResult({ effect: "deny", rule_id: "person_resolve", reason: { en: "The person refused.", pl: "Osoba odmówiła." } }, true);
  }
  const resolved = await state.engine.call({ cmd: "resolve", actor: "person", id: result.approval_id, decision: "allow" });
  if (!resolved.ok) return toolResult({ error: resolved.error }, true);
  let performed;
  if (resolved.result.fill_secret) {
    if (!answer.vault_text) {
      performed = await state.host.act({ op: "focus", ref: resolved.result.action.ref });
      performed = { ...performed, filled: false };
    } else {
      performed = await state.host.fillTrusted(resolved.result.action.ref, answer.vault_text);
      performed = { ok: !!performed?.ok, filled: true };
    }
  } else {
    performed = await state.host.act(resolved.result.action);
  }
  const after = await state.host.snapshot();
  return toolResult({ effect: "allow", rule_id: decision.rule_id, approved_by: "person", performed, snapshot: publicSnapshot(after) });
}

function startControl() {
  const server = createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end();
      return;
    }
    const token = req.headers["x-weft-token"];
    if (!sameToken(token, state.token)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/pending") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pending: state.pending }));
      return;
    }
    if (req.method === "POST" && req.url === "/call") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        const result = await enqueue(() => dispatch(body.name, body.arguments || {}));
        const payload = JSON.stringify(result);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload, () => {
          if (result?.structuredContent?.closed) void shutdown();
        });
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
      return;
    }
    if (req.method === "POST" && (req.url === "/approval" || req.url === "/gesture")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (req.url === "/gesture") {
        state.lastGesture = Date.now();
        state.gestures += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      const waiter = state.waiters.get(body.id);
      if (!waiter) {
        res.writeHead(404);
        res.end();
        return;
      }
      state.waiters.delete(body.id);
      waiter({ decision: body.decision, vault_text: body.vault_text });
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      resolve(server);
    });
  });
}

async function dispatch(name, args) {
  if (name === "weft_open") return submit({ op: "navigate", url: args.url });
  if (name === "weft_snapshot") return toolResult({ effect: "allow", snapshot: publicSnapshot(await state.host.snapshot()) });
  if (name === "weft_act") return submit(args);
  if (name === "weft_pending") {
    const pending = await state.engine.call({ cmd: "pending" });
    return toolResult({ pending: pending.result?.pending || null });
  }
  if (name === "weft_close") {
    return toolResult({ effect: "allow", closed: true });
  }
  return toolResult({ error: "unknown tool" }, true);
}

async function shutdown() {
  try {
    await state.host?.close();
  } catch {
    /* closing */
  }
  try {
    state.engine?.close();
  } catch {
    /* closing */
  }
  if (process.env.WEFT_CONTROL_FILE) await rm(process.env.WEFT_CONTROL_FILE, { force: true });
  process.exit(0);
}

let rpcBuf = "";

function reply(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function onMessage(msg) {
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "ping" && msg.id != null) {
    reply({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.id == null) return;
  try {
    if (msg.method === "initialize") {
      reply({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "weft", version: "0.1.0" },
        },
      });
      return;
    }
    if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      return;
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      const known = tools.some((tool) => tool.name === name);
      if (!known) {
        reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
        return;
      }
      const result = await callDaemon(name, args);
      reply({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  } catch (err) {
    reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err.message || err) } });
  }
}

const daemon = process.argv.includes("--daemon");
if (daemon) {
  const pack = JSON.parse(await readFile(packPath, "utf8"));
  state.pack = pack;
  state.engine = new Engine();
  state.host = process.env.WEFT_FAKE === "1" ? new FakeHost() : await CdpSession.launch({ headed: process.env.WEFT_HEADED === "1", pack });
  if (process.env.WEFT_FAKE === "1") await state.host.open();
  await startControl();
  await publish();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    rpcBuf += chunk;
    let nl;
    while ((nl = rpcBuf.indexOf("\n")) >= 0) {
      const line = rpcBuf.slice(0, nl).trim();
      rpcBuf = rpcBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
