// Minimal .env loader — no dotenv dependency, this project has none.
// Reads KEY=VALUE lines from .env at the repo root into process.env,
// without overwriting anything already set in the real environment.
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(root) {
  const envPath = path.join(root, '.env');
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = { loadEnv };
