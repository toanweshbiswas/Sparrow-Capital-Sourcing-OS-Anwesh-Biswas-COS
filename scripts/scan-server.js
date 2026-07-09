// Sparrow Sourcing OS — local server.
// Serves the static dashboard AND exposes POST /scan, which shells out to the
// `claude` CLI (your existing Claude Code login — no separate API key) to run
// a real /scan-raises pass, write results into data/*.json, and regenerate
// data.js. Each scan is a real agent run across a wide set of search angles
// (sector/source/investor/accelerator/regional/hiring-signal) — expect
// 5-10+ minutes and real usage against your Claude account, not a
// free/instant action.
//
// Run:  node scripts/scan-server.js
// Then open the URL it prints (default http://localhost:8787).
'use strict';

require('./load-env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8787;
// Wider search diameter (double-digit distinct queries across sector/source/
// investor/accelerator/regional/hiring angles, per sourcing-context.md) costs
// more per run than the original 2-3-query version — default budget raised
// accordingly. Override either via env var if needed.
const MAX_BUDGET_USD = process.env.SPARROW_SCAN_BUDGET_USD || '5';
const SCAN_WINDOW_DAYS = process.env.SPARROW_SCAN_WINDOW_DAYS || '7';

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

let scanState = { running: false, startedAt: null, finishedAt: null, exitCode: null, error: null };
let crawlState = { running: false, startedAt: null, finishedAt: null, exitCode: null, error: null, summary: null };

// Firecrawl crawl — runs scripts/firecrawl-scan.js directly (no Claude account
// usage, just the Firecrawl key). Fast sweep for founder departures + raises.
function runFirecrawl() {
  if (crawlState.running) return;
  crawlState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null, summary: null };

  const logPath = path.join(ROOT, 'data', 'firecrawl_log.txt');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n\n=== Firecrawl crawl started ${crawlState.startedAt} ===\n`);

  let child;
  try {
    child = spawn('node', [path.join(ROOT, 'scripts', 'firecrawl-scan.js')], {
      cwd: ROOT,
      // FIRECRAWL_API_KEY is inherited from the environment (set it in .env or
      // export it before starting the server). The child exits early if unset.
      env: { ...process.env },
    });
  } catch (err) {
    crawlState.running = false;
    crawlState.error = String(err);
    logStream.write(`Failed to spawn firecrawl-scan: ${err}\n`);
    logStream.end();
    return;
  }

  let tail = '';
  child.stdout.on('data', (b) => { tail += b.toString(); if (tail.length > 4000) tail = tail.slice(-4000); logStream.write(b); });
  child.stderr.pipe(logStream, { end: false });

  child.on('close', (code) => {
    crawlState.running = false;
    crawlState.exitCode = code;
    crawlState.finishedAt = new Date().toISOString();
    // The script prints a JSON summary line last; capture it if present.
    const m = tail.match(/\{"ok":true[^\n]*\}/);
    if (m) { try { crawlState.summary = JSON.parse(m[0]); } catch (e) {} }
    logStream.write(`\n=== Firecrawl crawl finished ${crawlState.finishedAt}, exit ${code} ===\n`);
    logStream.end();
  });

  child.on('error', (err) => {
    crawlState.running = false;
    crawlState.error = String(err);
    crawlState.finishedAt = new Date().toISOString();
    logStream.write(`\nProcess error: ${err}\n`);
    logStream.end();
  });
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, decodeURIComponent(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // No caching, ever: data.js is regenerated after every scan and must always
    // be re-fetched, not served stale from the browser's disk cache. The rest
    // of the site is small and local, so blanket no-store is simplest and safe.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(data);
  });
}

function runScan() {
  if (scanState.running) return;
  scanState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null };

  const prompt = [
    `Run /scan-raises for the last ${SCAN_WINDOW_DAYS} days per Sparrow Capital's thesis in references/sourcing-context.md.`,
    `Follow the "Search method — increasing diameter" section there: run distinct searches across every`,
    `angle (sector, source, investor-watchlist, accelerator/launch, regional, stealth/hiring-signal) —`,
    `aim for double-digit distinct queries this run, not 2-3, and rotate toward angles the last scan`,
    `under-covered (check ${ROOT}/data/last_scan.json's queriesRun/sourcesChecked from the previous run first).`,
    `The stealth/hiring angle ("the hiring tell") is mandatory every run, never rotated out: run the`,
    `site: ATS sweep for "founding engineer"/"first engineer"/"founding software engineer" India across`,
    `at least jobs.ashbyhq.com, boards.greenhouse.io, and jobs.lever.co (more from the full list in`,
    `sourcing-context.md if time allows) — any hit is Signal Type "Founding Engineer Hire", Urgency High.`,
    `Write every kept raise into ${ROOT}/data/companies.json and ${ROOT}/data/people.json,`,
    `following the local-JSON tracker convention documented in sourcing-context.md (no Airtable/Notion connector — plain JSON matching tracker-schema.md's shape).`,
    `Update ${ROOT}/data/last_scan.json with a real timestamp, the window, a queriesRun list (every distinct search actually run, tagged by angle), the sources checked, and the new-company count.`,
    `Then run: node scripts/regenerate-data-js.js  (cwd ${ROOT}) so the dashboard picks up the new data.`,
    `Do not scrape paywalled or ToS-restricted sources (no Tracxn login, no LinkedIn/X activity or profile scraping) — use public press, portfolio pages, and public job-board listings per the skill's own rules.`,
  ].join(' ');

  const args = [
    '-p', prompt,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Skill WebSearch WebFetch Read Write Edit Bash(node scripts/regenerate-data-js.js)',
    '--max-budget-usd', String(MAX_BUDGET_USD),
    '--output-format', 'json',
  ];

  const logPath = path.join(ROOT, 'data', 'scan_log.txt');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n\n=== Scan started ${scanState.startedAt} (budget $${MAX_BUDGET_USD}, window ${SCAN_WINDOW_DAYS}d) ===\n`);

  let child;
  try {
    child = spawn('claude', args, { cwd: ROOT });
  } catch (err) {
    scanState.running = false;
    scanState.error = String(err);
    logStream.write(`Failed to spawn claude CLI: ${err}\n`);
    logStream.end();
    return;
  }

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  child.on('close', (code) => {
    scanState.running = false;
    scanState.exitCode = code;
    scanState.finishedAt = new Date().toISOString();
    logStream.write(`\n=== Scan finished ${scanState.finishedAt}, exit code ${code} ===\n`);
    logStream.end();
  });

  child.on('error', (err) => {
    scanState.running = false;
    scanState.error = String(err);
    scanState.finishedAt = new Date().toISOString();
    logStream.write(`\nProcess error: ${err}\n`);
    logStream.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/scan') {
    if (scanState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A scan is already running.', state: scanState }));
    }
    runScan();
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'started', state: scanState }));
  }
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(scanState));
  }
  if (req.method === 'POST' && req.url === '/firecrawl-scan') {
    if (crawlState.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A crawl is already running.', state: crawlState }));
    }
    runFirecrawl();
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'started', state: crawlState }));
  }
  if (req.method === 'GET' && req.url === '/firecrawl-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(crawlState));
  }
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sparrow Sourcing OS — http://localhost:${PORT}`);
  console.log(`Scan endpoint: POST /scan (budget $${MAX_BUDGET_USD}/run, window ${SCAN_WINDOW_DAYS}d). Logs: data/scan_log.txt`);
});
