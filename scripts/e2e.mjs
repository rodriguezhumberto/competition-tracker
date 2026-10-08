import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const requested = process.argv.slice(2);
// Each test file gets a fresh server, database, credentials, and rate-limit state.
const files = readdirSync(new URL('../test/browser/', import.meta.url))
  .filter((file) => file.endsWith('.spec.ts'))
  .sort();
const groups = requested.length ? [requested] : files.map((file) => [`test/browser/${file}`]);

for (const args of groups) {
  const child = spawn(process.execPath, [cli, 'test', ...args], { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  if (code !== 0) process.exit(code);
}
