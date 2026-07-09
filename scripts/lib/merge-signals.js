// Merge/dedup logic for crawl results into the existing tracker arrays.
// Pure functions (array in, array out) so both the local fs-backed CLI
// (scripts/firecrawl-scan.js) and the Supabase-backed Netlify function
// (netlify/functions/firecrawl-scan-background.js) share one source of truth
// for how new signals get folded into existing records.
'use strict';

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

const SECTOR_CANON = { fintech: 'Fintech', b2b: 'B2B', saas: 'B2B', ai: 'AI', 'applied ai': 'AI', consumer: 'Consumer', d2c: 'Consumer', healthtech: 'Consumer' };
function canonSector(s) {
  const n = (s || '').toLowerCase();
  for (const k of Object.keys(SECTOR_CANON)) if (n.includes(k)) return SECTOR_CANON[k];
  return 'Consumer';
}
function canonStage(round) {
  const r = (round || '').toLowerCase();
  if (r.includes('pre')) return 'Pre-Seed';
  if (r.includes('angel')) return 'Pre-Seed';
  return 'Seed';
}

// existing: current departures array (mutated in place and returned).
// found: newly-crawled, normalized departure records.
function mergeDepartures(existing, found, nowIso = new Date().toISOString()) {
  const byKey = new Map(existing.map((d) => [norm(d.founder), d]));
  let added = 0;
  let nextId = existing.reduce((m, d) => Math.max(m, parseInt((d.id || 'd0').slice(1)) || 0), 0);
  for (const d of found) {
    const key = norm(d.founder);
    if (byKey.has(key)) {
      const cur = byKey.get(key);
      if (d.moveType === 'starting_own' && cur.moveType !== 'starting_own') {
        cur.moveType = 'starting_own';
        cur.currentBuilding = d.currentBuilding || cur.currentBuilding;
      }
      cur.currentBuilding = cur.currentBuilding && cur.currentBuilding !== 'New venture (details emerging)' ? cur.currentBuilding : d.currentBuilding;
      cur.linkedin = cur.linkedin || d.linkedin;
      cur.watchlisted = cur.watchlisted || d.watchlisted;
      continue;
    }
    nextId++;
    const rec = {
      id: `d${String(nextId).padStart(3, '0')}`,
      founder: d.founder,
      exEmployer: d.exEmployer,
      exDesignation: d.exDesignation,
      moveType: d.moveType || 'starting_own',
      currentBuilding: d.currentBuilding,
      sector: canonSector(d.sector) === 'Consumer' && d.sector ? d.sector : canonSector(d.sector),
      linkedin: d.linkedin,
      watchlisted: !!d.watchlisted,
      source: d.source,
      status: 'New Signal',
      foundAt: nowIso,
    };
    byKey.set(key, rec);
    existing.push(rec);
    added++;
  }
  return { merged: existing, added };
}

// existing: current companies array (mutated in place and returned).
// deals: newly-crawled, normalized raise records.
function mergeRaises(existing, deals, nowIso = new Date().toISOString()) {
  const byName = new Map(existing.map((c) => [norm(c.name), c]));
  let added = 0;
  let nextId = existing.reduce((m, c) => Math.max(m, parseInt((c.id || 'c0').slice(1)) || 0), 0);
  const clean = (v) => {
    const s = (v || '').trim();
    return /^(undisclosed|n\/?a|unknown|not disclosed|-)?$/i.test(s) ? '' : s;
  };
  for (const d of deals) {
    if (byName.has(norm(d.company))) continue;
    nextId++;
    const sector = canonSector(d.sector);
    const amount = clean(d.amount);
    const investors = clean(d.investors);
    const roundLabel = d.round || 'an early round';
    const whyNow = amount
      ? `Just raised ${amount} (${roundLabel})${investors ? ` from ${investors}` : ''} — capital just landed, founder is hiring and open to conversations now.`
      : `Recently closed ${roundLabel === 'an early round' ? 'an early round' : 'a ' + roundLabel + ' round'}${investors ? ` (${investors})` : ''} — early window to reach the founder before the round is fully deployed.`;
    const rec = {
      id: `c${String(nextId).padStart(3, '0')}`,
      name: d.company,
      website: '',
      sector,
      subSector: d.sector || '',
      stage: canonStage(d.round),
      geography: 'India',
      hq: 'India',
      description: d.description || `${d.company} — early-stage ${sector} startup.`,
      founderPedigree: [],
      founders: d.founders ? d.founders.split(/,|&|and/).map((n) => ({ name: n.trim(), role: 'Founder' })).filter((f) => f.name) : [],
      signalType: 'Angel / Pre-Seed Raise',
      signalSource: `Firecrawl crawl — ${d.source}`,
      urgency: 'High',
      thesisScore: 60,
      whyNow,
      whySparrow: `Early-stage ${sector} raise in India, surfaced by the live Firecrawl crawl. Fits the pre-seed / seed sourcing window.`,
      backedBy: investors ? investors.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3) : [],
      status: 'New Signal',
      createdAt: nowIso,
    };
    byName.set(norm(d.company), rec);
    existing.push(rec);
    added++;
  }
  return { merged: existing, added };
}

module.exports = { mergeDepartures, mergeRaises, norm, canonSector, canonStage };
