/**
 * Zero-dependency local HTTP server for the PI Remote web preview.
 * Serves static companion assets and exposes `packages/protocol/src/*.mjs` at `/protocol/*`
 * so browsers run the EXACT same X25519 + AES-256-GCM E2EE protocol as the Expo native app.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protocolDir = path.resolve(__dirname, "../../../packages/protocol/src");
const PORT = Number(process.env.WEB_PORT || 47930);
const HOST = process.env.WEB_HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const STATIC_ALLOW = new Set([
  "styles.css",
  "markdown.mjs",
  "app.mjs",
  "manifest.webmanifest",
]);

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url || "/", `http://${HOST}`).pathname;
  let target = null;

  if (urlPath === "/" || urlPath === "/index.html") {
    target = path.join(__dirname, "index.html");
  } else if (urlPath.startsWith("/protocol/")) {
    const fileName = path.basename(urlPath);
    if (/^[a-z0-9._-]+\.mjs$/i.test(fileName)) {
      target = path.join(protocolDir, fileName);
    }
  } else {
    const fileName = path.basename(urlPath);
    if (urlPath === `/${fileName}` && STATIC_ALLOW.has(fileName)) {
      target = path.join(__dirname, fileName);
    }
  }

  if (!target || !fs.existsSync(target)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = path.extname(target);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[mobile-web-preview] listening at http://${HOST}:${PORT}`);
});
