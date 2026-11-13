import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CdpSession } from "../hosts/cdp/driver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pack = JSON.parse(await readFile(path.join(root, "data", "runtime", "weft.pack"), "utf8"));
const html = `<!doctype html><meta charset="utf-8"><title>Weft</title>
<button id="more">More</button>
<input id="q" type="search" name="q" placeholder="Search">
<input id="pw" type="password" name="password" autocomplete="current-password">
<p id="out"></p>
<script>document.getElementById("more").addEventListener("click", () => { document.getElementById("out").textContent = "clicked"; });</script>`;

const session = await CdpSession.launch({ pack });
try {
  await session.evaluate("document.open();document.write(" + JSON.stringify(html) + ");document.close();");
  const snap = await session.snapshot();
  const more = snap.elements.find((el) => el.name === "More");
  const secret = snap.elements.find((el) => el.secret);
  if (!more || !secret || !snap.has_password_field) throw new Error("snapshot " + JSON.stringify(snap));
  if (JSON.stringify(snap).includes("value") && secret.value_preview) throw new Error("password value leaked");
  const clicked = await session.act({ op: "click", ref: more.ref });
  if (!clicked?.ok) throw new Error("click " + JSON.stringify(clicked));
  const after = await session.snapshot();
  const out = after.elements.find((el) => el.name === "clicked") || null;
  const text = await session.evaluate("document.getElementById('out').textContent");
  if (text !== "clicked") throw new Error("page did not receive the click: " + text + " outEl " + JSON.stringify(out));
  const refused = await session.act({ op: "type", ref: secret.ref, text: "hunter2" });
  if (refused?.error !== "secret_refused_by_page") throw new Error("page accepted a password " + JSON.stringify(refused));
  const trusted = await session.fillTrusted(secret.ref, "local-only");
  if (!trusted?.ok || trusted.echoed !== false) throw new Error("trusted fill " + JSON.stringify(trusted));
  const shown = await session.evaluate("document.getElementById('pw').value");
  if (shown !== "local-only") throw new Error("trusted fill did not land");
  const leaked = JSON.stringify(await session.snapshot());
  if (leaked.includes("local-only") || leaked.includes("hunter2")) throw new Error("snapshot leaked a secret");
  console.log("ok cdp");
} finally {
  await session.close();
}
