// Regenerates data.js from data/*.json — the dashboard's actual data source.
// Run this after any write to data/companies.json, people.json, vcs.json, or last_scan.json
// (i.e. after /scan-raises, /company-brief, /follow-ups, or a manual tracker edit).
//   node scripts/regenerate-data-js.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
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

const banner = `/* ================================================================
   Sparrow Capital Sourcing OS — data.js
   GENERATED FILE — do not hand-edit. Regenerated from data/*.json
   by scripts/regenerate-data-js.js after every tracker write.
   Source of truth lives in data/companies.json, data/people.json,
   data/vcs.json, data/touches.json.
   ================================================================ */
'use strict';

`;

const body =
  `const SEED_COMPANIES = ${JSON.stringify(companies, null, 2)};\n\n` +
  `const SEED_INVESTORS = ${JSON.stringify(investors, null, 2)};\n\n` +
  `const SEED_VCS = ${JSON.stringify(vcs, null, 2)};\n\n` +
  `const SEED_DEPARTURES = ${JSON.stringify(departures, null, 2)};\n\n` +
  `const SEED_MEMOS = ${JSON.stringify(memos, null, 2)};\n\n` +
  `const LAST_SCAN = ${JSON.stringify(lastScan, null, 2)};\n`;

fs.writeFileSync(outFile, banner + body);
console.log(`data.js regenerated: ${companies.length} companies, ${investors.length} investors, ${vcs.length} vcs, ${departures.length} departures, last scan: ${lastScan.timestamp || 'never'}`);
