// One-time (and re-runnable) upload of data/*.json into Supabase, matching
// db/schema.sql's JSON-per-row tables. Run this once after creating the
// Supabase project and applying schema.sql, and any time you want to force
// Supabase back in sync with the local JSON files.
//   node scripts/migrate-to-supabase.js
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
const { client } = require('./lib/supabase');

const ROOT = path.resolve(__dirname, '..');
loadEnv(ROOT);

const sb = client(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8')); }
  catch { return fallback; }
}

async function main() {
  const companies = readJson('companies.json', []);
  const investors = readJson('people.json', []);
  const vcs = readJson('vcs.json', []);
  const departures = readJson('departures.json', []);
  const memos = readJson('memos.json', []);
  const lastScan = readJson('last_scan.json', null);

  await sb.replaceAll('companies', companies.map(c => ({ id: c.id, data: c })));
  await sb.replaceAll('investors', investors.map(p => ({ id: p.id, data: p })));
  await sb.replaceAll('vcs', vcs.map(v => ({ id: v.id, data: v })));
  await sb.replaceAll('departures', departures.map(d => ({ id: d.id, data: d })));
  await sb.replaceAll('memos', memos.map(m => ({ id: m.id, data: m })));
  if (lastScan) await sb.upsert('meta', [{ key: 'last_scan', data: lastScan }], 'key');

  console.log(
    `Migrated to Supabase: ${companies.length} companies, ${investors.length} investors, ` +
    `${vcs.length} vcs, ${departures.length} departures, ${memos.length} memos, ` +
    `last_scan: ${lastScan?.timestamp || 'none'}`
  );
}

main().catch(err => { console.error(err); process.exit(1); });
