// "Build" for this action is a verbatim copy of src/index.js to dist/index.js.
// The action has zero runtime npm dependencies (native fetch + node:fs only),
// so there is nothing to bundle and the committed dist/ stays fully readable
// and auditable. CI verifies dist/ is in sync with src/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "index.js");
const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(src, path.join(distDir, "index.js"));
console.log("Copied src/index.js -> dist/index.js");
