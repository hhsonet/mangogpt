// Self-host the Monaco editor (no CDN): copy its runtime files into public/monaco so the browser loads them from our own origin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "monaco-editor", "min", "vs");
const dst = path.join(root, "public", "monaco", "vs");
if (!fs.existsSync(src)) {
  console.warn("monaco-editor is not installed; skipping copy");
  process.exit(0);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`Monaco copied to public/monaco/vs (${fs.readdirSync(dst).length} entries)`);
