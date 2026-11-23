import { createRelayServer } from './relay-core.mjs';

try {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error();
  const server = createRelayServer({
    maxFrameBytes: process.env.MAX_FRAME_BYTES === undefined ? undefined : Number(process.env.MAX_FRAME_BYTES),
    pushWebhookUrl: process.env.PUSH_WEBHOOK_URL,
    requireTickets: process.env.REQUIRE_TICKETS === '1',
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    try { await server.shutdown(); } catch { process.exitCode = 1; }
    finally { clearTimeout(timeout); }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.once('error', () => { console.error('Relay listener unavailable'); process.exitCode = 1; });
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.info(`pi-relay.v1 listening on port ${server.address().port}`));
} catch { console.error('Invalid relay configuration'); process.exitCode = 1; }
