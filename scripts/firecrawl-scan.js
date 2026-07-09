#!/usr/bin/env node
// ============================================================================
// Sparrow Sourcing OS — Firecrawl crawler (local CLI)
// ----------------------------------------------------------------------------
// Crawls the public web (via Firecrawl) for two live signals and writes the
// results straight into the dashboard's tracker (data/*.json), then regenerates
// data.js (and syncs Supabase, via regenerate-data-js.js) so the UI picks them up:
//
//   SIGNAL 1 — Founder-factory departures:
//     Senior people leaving Razorpay / Flipkart / CRED / Swiggy / PhonePe /
//     Meesho / Zerodha / Groww / … and — the part we care about — starting
//     their own company. Captured with: Founder, Ex-Employer, Ex-Designation,
//     Current Building, Sector, LinkedIn (best-effort). -> data/departures.json
//
//   SIGNAL 2 — Angel / pre-seed raises (last 6–12 months):
//     Early rounds announced across Indian startup press. -> appended to
//     data/companies.json in the existing tracker schema (signalType set to
//     "Angel / Pre-Seed Raise").
//
// The crawl + normalization logic lives in scripts/lib/firecrawl-crawl.js and
// scripts/lib/merge-signals.js, shared with netlify/functions/firecrawl-scan-background.js
// (which runs the same crawl but writes to Supabase instead of local files).
//
//   Run:  node scripts/firecrawl-scan.js
//   (reads FIRECRAWL_API_KEY from .env or the environment)
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadEnv } = require('./lib/env');
const { makeCrawler } = require('./lib/firecrawl-crawl');
const { mergeDepartures, mergeRaises } = require('./lib/merge-signals');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
loadEnv(ROOT);

const API_KEY = process.env.FIRECRAWL_API_KEY;
if (!API_KEY) {
  console.error('[firecrawl-scan] FIRECRAWL_API_KEY is not set (add it to .env or the environment).');
  process.exit(1);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function main() {
  const started = new Date();
  const nowIso = started.toISOString();
  console.log(`[firecrawl-scan] starting crawl @ ${nowIso}`);

  const crawler = makeCrawler(API_KEY);
  const { allDeps, allDeals, snippetSignals } = await crawler.runCrawl();

  const existingDepartures = readJson(path.join(DATA, 'departures.json'), []);
  const { merged: departures, added: depAdded } = mergeDepartures(existingDepartures, allDeps, nowIso);
  fs.writeFileSync(path.join(DATA, 'departures.json'), JSON.stringify(departures, null, 2));

  // Snippet leads (unverified) — a lightweight parallel list for manual review.
  fs.writeFileSync(path.join(DATA, 'departure_leads.json'), JSON.stringify(snippetSignals.slice(0, 40), null, 2));

  const existingCompanies = readJson(path.join(DATA, 'companies.json'), []);
  const { merged: companies, added: raiseAdded } = mergeRaises(existingCompanies, allDeals, nowIso);
  fs.writeFileSync(path.join(DATA, 'companies.json'), JSON.stringify(companies, null, 2));

  // Update the scan-status file the dashboard reads.
  const lastScan = readJson(path.join(DATA, 'last_scan.json'), {});
  const merged = {
    ...lastScan,
    timestamp: nowIso,
    window: 'last ~12 months (qdr:y)',
    engine: 'firecrawl',
    sourcesChecked: ['news search', 'funding roundups', 'inc42/buzz', 'x.com/TheCEO_Magazine'],
    newCompanies: raiseAdded,
    newDepartures: depAdded,
    departuresFound: allDeps.length,
    raisesFound: allDeals.length,
  };
  fs.writeFileSync(path.join(DATA, 'last_scan.json'), JSON.stringify(merged, null, 2));

  // Regenerate data.js (and sync Supabase) so the dashboard reflects the crawl.
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'regenerate-data-js.js')], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) { console.error('[firecrawl-scan] regenerate failed:', e.message); }

  const secs = Math.round((Date.now() - started.getTime()) / 1000);
  console.log(`[firecrawl-scan] DONE in ${secs}s — +${depAdded} departures, +${raiseAdded} raises`);
  console.log(JSON.stringify({ ok: true, depAdded, raiseAdded, departuresFound: allDeps.length, raisesFound: allDeals.length, seconds: secs }));
}

main().catch((e) => { console.error('[firecrawl-scan] fatal', e); process.exit(1); });
