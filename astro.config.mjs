import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import './src/lib/env.ts';
import { productionHostname } from './src/lib/production-hostname.ts';

const hostname = productionHostname(
  process.env.PRODUCTION_HOSTNAME,
  process.env.REQUIRE_PRODUCTION_HOSTNAME === 'true',
);

export default defineConfig({
  site: hostname ? `https://${hostname}` : undefined,
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: {
    allowedDomains: [
      ...(hostname ? [{ hostname, protocol: 'https' }] : []),
      // Local development, browser tests, and container health checks.
      { hostname: 'localhost', protocol: 'http' },
      { hostname: '127.0.0.1', protocol: 'http' },
    ],
  },
  integrations: [
    {
      name: 'power-hour-websocket',
      hooks: {
        'astro:server:setup': async ({ server }) => {
          const { attachRealtime } = await import('./src/lib/realtime.ts');
          attachRealtime(server.httpServer);
          const { cleanupRetainedData, startRetentionCleanup } =
            await import('./src/lib/retention.ts');
          await cleanupRetainedData();
          const stopRetentionCleanup = startRetentionCleanup();
          server.httpServer?.once('close', stopRetentionCleanup);
        },
      },
    },
  ],
  vite: { plugins: [tailwindcss()], optimizeDeps: { include: ['alpinejs'] } },
});
