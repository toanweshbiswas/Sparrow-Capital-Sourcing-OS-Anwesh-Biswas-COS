#!/usr/bin/env node
// ============================================================================
// Sparrow Sourcing OS — one-time data cleanup
// ----------------------------------------------------------------------------
// Removes fabricated / hallucinated companies that the Firecrawl extractor
// invented when it scraped aggregator/index/macro pages that carried no clean
// per-deal data (a TechCrunch year-end macro article, entrackr's bare
// monthly/weekly report index pages, vccircle's category index, x.com). Those
// pages produced textbook placeholder rows ("John Doe" founders, "Investor C",
// "XYZ Innovations", etc.).
//
// It then, for every SURVIVING crawled raise:
//   • reclassifies sector from the preserved raw `subSector` (the old
//     canonSector() defaulted almost everything to "Consumer"),
//   • recomputes thesisScore from real attributes instead of a flat 60,
//   • re-derives urgency instead of a blanket "High".
//
// Also removes the single placeholder person that leaked into people.json.
//
//   Dry run (report only):  node scripts/clean-fabricated.js --dry
//   Apply:                  node scripts/clean-fabricated.js
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { canonSector, scoreCrawled, deriveUrgency, isFabricated, UNRELIABLE_SOURCE_RE } = require('./crawl-lib');

const DRY = process.argv.includes('--dry');
const DATA = path.join(__dirname, '..', 'data');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const companies = readJson('companies.json');
const people = readJson('people.json');

// A crawled raise is dropped if it looks fabricated OR its only provenance is
// an unreliable aggregator/index/macro/social page.
function shouldDrop(c) {
  if (c.signalType !== 'Angel / Pre-Seed Raise') return null; // only touch crawled raises
  if (isFabricated(c)) return 'fabricated (placeholder name/founder/investor)';
  const src = (c.signalSource || '').replace('Firecrawl crawl — ', '');
  if (UNRELIABLE_SOURCE_RE.test(src)) return 'unreliable source (aggregator/index/macro page)';
  return null;
}

const kept = [];
const dropped = [];
for (const c of companies) {
  const reason = shouldDrop(c);
  if (reason) { dropped.push({ id: c.id, name: c.name, reason }); continue; }
  kept.push(c);
}

// ── Near-duplicate pass ────────────────────────────────────────────────────
// Same company crawled twice under slightly different names (Skyroot Aerospace
// / Skyroot, Aurm / Aurum). Keep the richer record; drop the thinner one.
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}
const richness = (c) => Object.values(c).filter((v) => v && (!Array.isArray(v) || v.length)).length;
const dupDropped = [];
for (let i = 0; i < kept.length; i++) {
  for (let j = i + 1; j < kept.length; j++) {
    const a = kept[i], b = kept[j];
    if (!a || !b) continue;
    const na = norm(a.name), nb = norm(b.name);
    if (!na || !nb) continue;
    const same = na === nb
      || ((na.includes(nb) || nb.includes(na)) && Math.min(na.length, nb.length) >= 5)
      || (lev(na, nb) <= 1 && (a.subSector || '') === (b.subSector || ''));
    if (!same) continue;
    const loser = richness(a) >= richness(b) ? j : i;
    dupDropped.push({ id: kept[loser].id, name: kept[loser].name, reason: `duplicate of ${kept[loser === j ? i : j].name}` });
    kept[loser] = null;
  }
}
const deduped = kept.filter(Boolean);
kept.length = 0;
kept.push(...deduped);

// Re-derive sector / score / urgency for surviving crawled raises.
let reclassified = 0;
for (const c of kept) {
  if (c.signalType !== 'Angel / Pre-Seed Raise') continue;
  const before = { sector: c.sector, thesisScore: c.thesisScore, urgency: c.urgency };
  c.sector = canonSector(c.subSector || c.sector);
  c.thesisScore = scoreCrawled(c);
  c.urgency = deriveUrgency(c);
  if (before.sector !== c.sector || before.thesisScore !== c.thesisScore || before.urgency !== c.urgency) reclassified++;
}

// People: drop the placeholder that leaked in.
const peopleKept = people.filter((p) => !isFabricated(p));
const peopleDropped = people.length - peopleKept.length;

// ── Report ────────────────────────────────────────────────────────────────
console.log(`\n=== Sparrow data cleanup ${DRY ? '(DRY RUN — nothing written)' : ''} ===`);
console.log(`companies: ${companies.length} → ${kept.length}  (dropped ${dropped.length})`);
console.log(`people:    ${people.length} → ${peopleKept.length}  (dropped ${peopleDropped})`);
console.log(`crawled raises re-derived (sector/score/urgency): ${reclassified}\n`);
console.log(`duplicates merged: ${dupDropped.length}\n`);
console.log('Dropped companies:');
for (const d of dropped.concat(dupDropped)) console.log(`  ✗ ${d.id}  ${d.name}  — ${d.reason}`);

const secMix = {};
kept.forEach((c) => { secMix[c.sector] = (secMix[c.sector] || 0) + 1; });
const urgMix = {};
kept.forEach((c) => { urgMix[c.urgency] = (urgMix[c.urgency] || 0) + 1; });
const scores = kept.map((c) => c.thesisScore).filter((n) => typeof n === 'number');
console.log('\nAfter cleanup:');
console.log('  sector mix:', JSON.stringify(secMix));
console.log('  urgency mix:', JSON.stringify(urgMix));
console.log('  avg thesisScore:', (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
  '| 80+:', scores.filter((s) => s >= 80).length);

if (DRY) { console.log('\n(dry run — re-run without --dry to write)\n'); process.exit(0); }

fs.writeFileSync(path.join(DATA, 'companies.json'), JSON.stringify(kept, null, 2));
fs.writeFileSync(path.join(DATA, 'people.json'), JSON.stringify(peopleKept, null, 2));
console.log('\nWrote data/companies.json and data/people.json. Run scripts/regenerate-data-js.js next.\n');
