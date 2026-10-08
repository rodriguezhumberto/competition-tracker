import './src/lib/env.ts';
import { assertProductionAdminPasscode, cleanupAdminSessions } from './src/lib/auth.ts';
process.env.NODE_ENV ||= 'production';
assertProductionAdminPasscode();
cleanupAdminSessions();
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const { startServer } = await import('./dist/server/entry.mjs');
const { attachRealtime } = await import('./src/lib/realtime.ts');
const { cleanupRetainedData, startRetentionCleanup } = await import('./src/lib/retention.ts');
await cleanupRetainedData();
const stopRetentionCleanup = startRetentionCleanup();
const { server, done } = startServer();
server.server.once('close', stopRetentionCleanup);
const wss = attachRealtime(server.server);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    for (const client of wss.clients) client.terminate();
    await server.stop();
    process.exit(0);
  });
await done;
