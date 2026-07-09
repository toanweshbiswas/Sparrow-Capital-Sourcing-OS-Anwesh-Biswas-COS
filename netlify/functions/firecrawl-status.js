// Polled by app.js (_pollFirecrawl) while a crawl runs on the hosted site.
// Mirrors the shape of scan-server.js's crawlState / GET /firecrawl-status.
'use strict';

const { client } = require('../../scripts/lib/supabase');

const IDLE = { running: false, startedAt: null, finishedAt: null, exitCode: null, error: null, summary: null };

exports.handler = async () => {
  try {
    const sb = client(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const rows = await sb.selectAll('meta', 'key');
    const row = rows.find((r) => r.key === 'firecrawl_status');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row ? row.data : IDLE),
    };
  } catch (err) {
    // Non-200 here (not just an idle/error state body) so app.js's pingFirecrawl()
    // treats a broken Supabase config as "backend not available" and shows the
    // right guidance, rather than reporting a crawl failure that never ran.
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...IDLE, error: `Supabase unreachable: ${err.message}` }),
    };
  }
};
