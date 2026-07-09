// Runs the Firecrawl crawl on Netlify's infrastructure (Background Function —
// up to 15 min, returns 202 immediately) and writes results straight to
// Supabase instead of local data/*.json (Netlify functions have no durable
// local filesystem). Shares the crawl + merge logic with the local CLI
// (scripts/firecrawl-scan.js) via scripts/lib/firecrawl-crawl.js and
// scripts/lib/merge-signals.js.
//
// Needs FIRECRAWL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY set as
// Netlify environment variables (Site settings -> Environment variables).
'use strict';

const { client } = require('../../scripts/lib/supabase');
const { makeCrawler } = require('../../scripts/lib/firecrawl-crawl');
const { mergeDepartures, mergeRaises } = require('../../scripts/lib/merge-signals');

async function setStatus(sb, data) {
  await sb.upsert('meta', [{ key: 'firecrawl_status', data }], 'key');
}

exports.handler = async () => {
  const sb = client(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const startedAt = new Date().toISOString();

  const existing = await sb.selectAll('meta', 'key').catch(() => []);
  if ((existing.find((r) => r.key === 'firecrawl_status') || {}).data?.running) {
    return; // a crawl is already running — background functions have no caller to tell, so just no-op
  }

  await setStatus(sb, { running: true, startedAt, finishedAt: null, exitCode: null, error: null, summary: null });

  try {
    if (!process.env.FIRECRAWL_API_KEY) throw new Error('FIRECRAWL_API_KEY is not set in the Netlify environment');

    const crawler = makeCrawler(process.env.FIRECRAWL_API_KEY);
    const { allDeps, allDeals } = await crawler.runCrawl();

    const nowIso = new Date().toISOString();
    const [departureRows, companyRows, metaRows] = await Promise.all([
      sb.selectAll('departures'),
      sb.selectAll('companies'),
      sb.selectAll('meta', 'key'),
    ]);

    const { merged: departures, added: depAdded } = mergeDepartures(departureRows.map((r) => r.data), allDeps, nowIso);
    const { merged: companies, added: raiseAdded } = mergeRaises(companyRows.map((r) => r.data), allDeals, nowIso);

    await sb.replaceAll('departures', departures.map((d) => ({ id: d.id, data: d })));
    await sb.replaceAll('companies', companies.map((c) => ({ id: c.id, data: c })));

    const prevLastScan = (metaRows.find((r) => r.key === 'last_scan') || {}).data || {};
    await sb.upsert('meta', [{
      key: 'last_scan',
      data: {
        ...prevLastScan,
        timestamp: nowIso,
        window: 'last ~12 months (qdr:y)',
        engine: 'firecrawl',
        sourcesChecked: ['news search', 'funding roundups', 'inc42/buzz', 'x.com/TheCEO_Magazine'],
        newCompanies: raiseAdded,
        newDepartures: depAdded,
        departuresFound: allDeps.length,
        raisesFound: allDeals.length,
      },
    }], 'key');

    await setStatus(sb, {
      running: false,
      startedAt,
      finishedAt: nowIso,
      exitCode: 0,
      error: null,
      summary: { ok: true, depAdded, raiseAdded, departuresFound: allDeps.length, raisesFound: allDeals.length },
    });
  } catch (err) {
    console.error('firecrawl-scan-background failed:', err);
    await setStatus(sb, {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      error: err.message || String(err),
      summary: null,
    }).catch(() => {});
  }
};
