# Third-Party Notices

This plugin has **zero runtime third-party npm dependencies**.

All protocol, X25519 Diffie-Hellman (RFC 7748), AES-256-GCM WebCrypto envelope, RFC 6455 WebSocket server, and SVG QR encoder logic is implemented directly in first-party MIT-licensed JavaScript using Node.js standard library APIs (`node:http`, `node:crypto`, `node:fs`, `node:os`, `node:path`, `node:child_process`) and standard WebCrypto (`globalThis.crypto.subtle`).
