// Regenerates data.js from data/*.json — the dashboard's fallback data source
// — and syncs the same data into Supabase, which scan-server.js reads live on
// every request (see scripts/lib/supabase.js and db/schema.sql).
// Run this after any write to data/companies.json, people.json, vcs.json, or last_scan.json
// (i.e. after /scan-raises, /company-brief, /follow-ups, or a manual tracker edit).
//   node scripts/regenerate-data-js.js
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
const { client } = require('./lib/supabase');
const { buildDataJs } = require('./lib/build-data-js');

const root = path.resolve(__dirname, '..');
loadEnv(root);
const dataDir = path.join(root, 'data');
const outFile = path.join(root, 'data.js');

const companies = JSON.parse(fs.readFileSync(path.join(dataDir, 'companies.json'), 'utf8'));
const people = JSON.parse(fs.readFileSync(path.join(dataDir, 'people.json'), 'utf8'));
const vcs = JSON.parse(fs.readFileSync(path.join(dataDir, 'vcs.json'), 'utf8'));
const lastScan = JSON.parse(fs.readFileSync(path.join(dataDir, 'last_scan.json'), 'utf8'));
// Founder-factory departures (from the Firecrawl crawl). Optional — the
// dashboard shows an empty state if the crawl hasn't run yet.
function readOptional(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const departures = readOptional(path.join(dataDir, 'departures.json'), []);
// Investment-memo library (analyzed from 100x.vc + the Jarvis collection).
const memos = readOptional(path.join(dataDir, 'memos.json'), []);

// Dashboard's Investors view expects individuals only (SEED_INVESTORS shape).
const investors = people.filter(p => p.type === 'Angel');

fs.writeFileSync(outFile, buildDataJs({ companies, investors, vcs, departures, memos, lastScan }));
console.log(`data.js regenerated: ${companies.length} companies, ${investors.length} investors, ${vcs.length} vcs, ${departures.length} departures, last scan: ${lastScan.timestamp || 'never'}`);

// Best-effort Supabase sync — the local data.js above is written regardless,
// so a missing/misconfigured Supabase project never blocks the dashboard.
async function syncSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('Supabase sync skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
    return;
  }
  const sb = client(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await sb.replaceAll('companies', companies.map(c => ({ id: c.id, data: c })));
  await sb.replaceAll('investors', people.map(p => ({ id: p.id, data: p })));
  await sb.replaceAll('vcs', vcs.map(v => ({ id: v.id, data: v })));
  await sb.replaceAll('departures', departures.map(d => ({ id: d.id, data: d })));
  await sb.replaceAll('memos', memos.map(m => ({ id: m.id, data: m })));
  await sb.upsert('meta', [{ key: 'last_scan', data: lastScan }], 'key');
  console.log('Supabase synced.');
}

syncSupabase().catch(err => console.error('Supabase sync failed:', err.message));
