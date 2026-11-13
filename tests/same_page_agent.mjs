import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = await readFile(path.join(root, "hosts", "shared", "page_agent.js"));
const android = await readFile(path.join(root, "android", "app", "src", "main", "assets", "page_agent.js"));
if (!desktop.equals(android)) {
  console.error("page_agent.js on Android is not the desktop file");
  process.exit(1);
}
console.log("ok same page agent");
