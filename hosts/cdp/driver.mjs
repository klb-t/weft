// Chromium DevTools host. Windows and Linux share this file; spawn.mjs is the fork.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./spawn.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentPath = path.join(here, "..", "shared", "page_agent.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class CdpSocket {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "cdp error"));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        this.events.push(msg);
        if (this.events.length > 200) this.events.shift();
      }
    });
  }
  send(method, params = {}, timeout = 20000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("cdp timeout " + method));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  waitEvent(name, timeout = 20000) {
    const existing = this.events.find((e) => e.method === name);
    if (existing) return Promise.resolve(existing.params || {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp event timeout " + name)), timeout);
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === name) {
          clearTimeout(timer);
          this.ws.removeEventListener("message", onMessage);
          resolve(msg.params || {});
        }
      };
      this.ws.addEventListener("message", onMessage);
    });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("devtools websocket failed")), { once: true });
  });
  return new CdpSocket(ws);
}

export class CdpSession {
  constructor() {
    this.child = null;
    this.socket = null;
    this.dir = "";
    this.script = "";
    this.pageConfig = {};
  }

  static async launch({ headed = false, pack } = {}) {
    const session = new CdpSession();
    session.pageConfig = pack?.defaults?.page || {};
    session.script = await readFile(agentPath, "utf8");
    session.dir = await mkdtemp(path.join(tmpdir(), "weft-"));
    const port = await freePort();
    session.child = launchChrome({ port, userDataDir: session.dir, headed });
    let version;
    let last = "";
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          version = await res.json();
          break;
        }
      } catch (err) {
        last = String(err);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!version) throw new Error("Chromium did not open a DevTools port (" + last + ")");
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!listRes.ok) throw new Error("Chromium target list failed");
    const list = await listRes.json();
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("Chromium opened no page");
    const pageSocket = await connect(page.webSocketDebuggerUrl);
    session.socket = pageSocket;
    session.browser = pageSocket;
    session.send = (method, params) => pageSocket.send(method, params || {});
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    return session;
  }

  async navigate(url) {
    this.browser.events = this.browser.events.filter((event) => event.method !== "Page.loadEventFired");
    const loaded = this.browser.waitEvent("Page.loadEventFired", 12000);
    const nav = await this.send("Page.navigate", { url });
    if (nav.errorText) throw new Error(nav.errorText);
    if (!nav.loaderId) return this.snapshot();
    try {
      await loaded;
    } catch (err) {
      const state = await this.evaluate("document.readyState").catch(() => "");
      if (state !== "complete" && state !== "interactive") throw err;
    }
    return this.snapshot();
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || "page exception";
      throw new Error(text);
    }
    return result.result ? result.result.value : undefined;
  }

  prelude() {
    return "globalThis.__weftConfig = " + JSON.stringify(this.pageConfig) + ";\n" + this.script + "\n";
  }

  async snapshot() {
    return this.evaluate(this.prelude() + "__weft.snapshot()");
  }

  async act(action) {
    if (action.op === "navigate") {
      await this.navigate(action.url);
      return { ok: true };
    }
    if (action.op === "reload") {
      const loaded = this.browser.waitEvent("Page.loadEventFired");
      await this.send("Page.reload");
      await loaded;
      return { ok: true };
    }
    if (action.op === "back" || action.op === "forward") {
      await this.evaluate("history." + (action.op === "back" ? "back" : "forward") + "()");
      return { ok: true };
    }
    return this.evaluate(this.prelude() + "__weft.act(" + JSON.stringify(action) + ")");
  }

  async fillTrusted(ref, text) {
    // The secret stays in this process. Callers must not log the expression.
    return this.evaluate(this.prelude() + "__weft.fillTrusted(" + JSON.stringify(ref) + "," + JSON.stringify(text) + ")");
  }

  async close() {
    try {
      this.browser?.ws.close();
    } catch {
      /* already gone */
    }
    if (this.child && this.child.exitCode == null) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (this.child.exitCode == null) this.child.kill("SIGKILL");
    }
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
