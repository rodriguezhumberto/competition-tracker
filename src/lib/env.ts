import { existsSync } from 'node:fs';
// Runtime values win over the optional local .env file.
if (existsSync('.env')) process.loadEnvFile('.env');
