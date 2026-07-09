// Serves data.js live from Supabase on the hosted Netlify site — the same
// job scripts/scan-server.js's serveDataJs() does for localhost. Mirrors it
// exactly (same shared build-data-js.js) so the dashboard behaves the same
// wherever it's loaded from.
'use strict';

const { client } = require('../../scripts/lib/supabase');
const { buildDataJs } = require('../../scripts/lib/build-data-js');

exports.handler = async () => {
  const sb = client(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const [companiesRows, investorsRows, vcsRows, departuresRows, memosRows, metaRows] = await Promise.all([
      sb.selectAll('companies'),
      sb.selectAll('investors'),
      sb.selectAll('vcs'),
      sb.selectAll('departures'),
      sb.selectAll('memos'),
      sb.selectAll('meta', 'key'),
    ]);
    const lastScanRow = metaRows.find((r) => r.key === 'last_scan');
    const body = buildDataJs({
      companies: companiesRows.map((r) => r.data),
      investors: investorsRows.map((r) => r.data).filter((p) => p.type === 'Angel'),
      vcs: vcsRows.map((r) => r.data),
      departures: departuresRows.map((r) => r.data),
      memos: memosRows.map((r) => r.data),
      lastScan: lastScanRow ? lastScanRow.data : null,
    });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
      body,
    };
  } catch (err) {
    console.error('data-js function failed:', err);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/javascript' },
      body: `console.error(${JSON.stringify('data.js: Supabase query failed — ' + err.message)});`,
    };
  }
};
