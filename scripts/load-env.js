// Minimal .env loader (no dependency). Reads KEY=VALUE lines from the repo-root
// .env (gitignored) into process.env without overwriting already-set vars.
// require('./load-env') at the top of any entrypoint that needs secrets.
'use strict';
const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '..', '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // No .env file — rely on the real environment.
}
