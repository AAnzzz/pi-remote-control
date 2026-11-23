import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const srcDir = path.resolve(pluginRoot, "../../packages/protocol/src");
const dstDir = path.resolve(pluginRoot, "src/vendor/protocol");

fs.mkdirSync(dstDir, { recursive: true });
const files = ["x25519.mjs", "crypto.mjs", "validators.mjs", "cursor.mjs", "index.mjs"];
for (const file of files) {
  fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
}
console.log(`[sync-protocol] copied ${files.length} files to src/vendor/protocol`);
