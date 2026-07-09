#!/usr/bin/env node
// ============================================================================
// Sparrow Sourcing OS — Firecrawl crawler
// ----------------------------------------------------------------------------
// Crawls the public web (via Firecrawl) for two live signals and writes the
// results straight into the dashboard's tracker (data/*.json), then regenerates
// data.js so the UI picks them up:
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
// No separate LLM key is required — structured extraction is done by Firecrawl's
// /v2/scrape "json" format. Only the Firecrawl key is needed.
//
//   Run:  FIRECRAWL_API_KEY=fc-... node scripts/firecrawl-scan.js
//   (falls back to the key baked below if the env var is unset)
// ============================================================================
'use strict';

require('./load-env');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  isFabricated, canonSector, scoreCrawled, deriveUrgency, UNRELIABLE_SOURCE_RE,
} = require('./crawl-lib');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Read the Firecrawl key from the environment (never hard-code a secret). Set it
// in a local .env (gitignored) or export it before running:
//   FIRECRAWL_API_KEY=fc-... node scripts/firecrawl-scan.js
const API_KEY = process.env.FIRECRAWL_API_KEY;
if (!API_KEY) {
  console.error('[firecrawl-scan] FIRECRAWL_API_KEY is not set — export it or add it to .env before running.');
  process.exit(1);
}
const BASE = 'https://api.firecrawl.dev';

// How hard to crawl. Each scrape ≈ 5 Firecrawl credits, so these bound cost.
const MAX_DEPARTURE_SCRAPES = Number(process.env.SPARROW_DEP_SCRAPES || 16);
const MAX_RAISE_SCRAPES = Number(process.env.SPARROW_RAISE_SCRAPES || 14);
const SEARCH_LIMIT = Number(process.env.SPARROW_SEARCH_LIMIT || 5);

// "Founder factory" watchlist. NOTE: this is no longer a hard filter — we now
// capture senior leadership exits at ANY large/notable company. This list is
// used to (a) generate targeted searches and (b) flag high-signal moves
// (watchlisted:true) so alumni of these companies float to the top.
const FOUNDER_FACTORIES = [
  'Razorpay', 'Flipkart', 'CRED', 'Swiggy', 'Meesho', 'PhonePe', 'Freshworks',
  'Zerodha', 'Groww', 'Upstox', 'Myntra', 'Zepto', 'Amazon India', 'Cashfree', 'Zypp',
  'Paytm', 'Ola', 'Ola Electric', 'Nykaa', 'Byju\'s', 'Unacademy', 'Dream11',
  'Dream Sports', 'PharmEasy', 'Delhivery', 'Lenskart', 'Pine Labs', 'Navi',
  'Slice', 'Urban Company', 'ShareChat', 'BigBasket', 'Dunzo', 'Cars24', 'Udaan',
  'Razorpay', 'Rapido', 'Physics Wallah', 'Mamaearth', 'boAt', 'InMobi', 'Postman',
];

// Titles that qualify as "senior leadership" — a quality gate that replaces the
// old founder-factory hard filter now that we crawl any large company.
const SENIOR_TITLE_RE = /\b(founder|co-?founder|ceo|coo|cto|cfo|cpo|cmo|cbo|cro|cxo|chief|president|vice[-\s]?president|\bvp\b|svp|evp|managing director|\bmd\b|director|head of|group head|general manager|\bgm\b|partner|executive chairman|chairman)\b/i;

// Domains Firecrawl can actually render into clean article text. Social walls
// (instagram/facebook/x/linkedin feed posts) scrape poorly, so we skip them for
// extraction (their snippets still count as a discovery signal).
const NEWS_DOMAINS = [
  'entrackr.com', 'inc42.com', 'yourstory.com', 'vccircle.com', 'moneycontrol.com',
  'economictimes.indiatimes.com', 'livemint.com', 'business-standard.com',
  'financialexpress.com', 'techcrunch.com', 'startupstory.in', 'startuptalky.com',
  'the-ken.com', 'medianama.com', 'timesofindia.indiatimes.com', 'businessinsider.in',
  'cnbctv18.com', 'forbesindia.com', 'thehindubusinessline.com', 'bwdisrupt.com',
  'techinasia.com', 'fortuneindia.com', 'entrepreneur.com', 'analyticsindiamag.com',
];

// Funding-roundup pages worth scraping directly for raises. NOTE: bare
// aggregator/index pages (entrackr.com/monthly-funding-report, .../tag/funding,
// vccircle.com/category/startup) and macro articles were REMOVED — they carry no
// clean per-deal structure, so the extractor hallucinated placeholder companies
// ("XYZ Innovations", "John Doe" founders) off them. See UNRELIABLE_SOURCE_RE in
// crawl-lib.js. We keep only tag pages that reliably list named, dated deals; the
// search() pass below still discovers specific per-deal article + snippet URLs.
const RAISE_LISTING_URLS = [
  'https://inc42.com/tag/funding-galore/',
  'https://yourstory.com/tag/funding',
];

// "Rich signal" feeds — general startup-news pages that carry BOTH fresh funding
// announcements AND early market signals (departures, launches). JS-heavy, so
// full-render. x.com/social feeds were removed (no per-deal structure → fabricated
// extractions). We run BOTH the raise and departure extractors against each.
const RICH_SIGNAL_URLS = [
  'https://inc42.com/buzz/',
  'https://inc42.com/tag/funding-galore/',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fc(endpoint, body, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(`${BASE}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * attempt);
        continue;
      }
      const json = await res.json();
      return json;
    } catch (err) {
      if (attempt === tries) return { success: false, error: String(err) };
      await sleep(1200 * attempt);
    }
  }
  return { success: false, error: 'exhausted retries' };
}

// Firecrawl web search, restricted to roughly the last year (qdr:y).
async function search(query) {
  const out = await fc('/v2/search', { query, limit: SEARCH_LIMIT, tbs: 'qdr:y' });
  const results = (out && (out.data?.web || out.data)) || [];
  return Array.isArray(results) ? results : [];
}

// Firecrawl scrape + structured (LLM) extraction against a schema.
// opts.fullRender=true renders the whole page (needed for JS feeds like
// inc42/buzz and x.com, which return nothing with onlyMainContent).
async function scrapeJson(url, prompt, schema, opts = {}) {
  const body = {
    url,
    onlyMainContent: opts.fullRender ? false : true,
    formats: [{ type: 'json', prompt, schema }],
  };
  if (opts.fullRender) body.waitFor = opts.waitFor || 3500;
  const out = await fc('/v2/scrape', body);
  if (!out || !out.success) return null;
  return out.data?.json || null;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isNews = (u) => NEWS_DOMAINS.some((d) => hostOf(u).endsWith(d));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

function log(...a) { console.log(`[firecrawl-scan]`, ...a); }

// Apply the leadership-move gates to one extracted record → normalized record
// or null. Shared by the news-article scan and the rich-signal-feed scan so
// every source gets the same anti-hallucination / relevance filtering.
// Captures two move types (starting_own, stepped_down) at ANY large company —
// gated on "senior leader" + explicit confidence rather than a company list.
function normalizeMove(d, sourceUrl) {
  if (!d || !d.person || !d.company) return null;
  const moveType = d.moveType === 'starting_own' ? 'starting_own' : d.moveType === 'stepped_down' ? 'stepped_down' : null;
  if (!moveType) return null;
  if (d.confidence !== 'explicit') return null; // explicit-only → controls hallucination
  const designation = (d.designation || '').trim();
  // Quality gate: must be a senior leader. Trust the model's flag, but also
  // require the title to read as senior when a title is present.
  if (d.seniorLeader !== true) return null;
  if (designation && !SENIOR_TITLE_RE.test(designation)) return null;

  const company = d.company.trim();
  const cN = norm(company);
  const factory = FOUNDER_FACTORIES.find((f) => cN.includes(norm(f)) || norm(f).includes(cN));
  const watchlisted = !!factory;

  let building = '';
  if (moveType === 'starting_own') {
    building = (d.newVenture || '').trim();
    if (!building) return null; // starting_own with no named/described venture → not actionable
    const bN = norm(building);
    if (bN === cN || bN.includes(cN) || cN.includes(bN)) return null; // "new co" == the company they left
  }

  let li = (d.linkedin || '').trim();
  if (li && !/linkedin\.com\/in\//i.test(li)) li = ''; // drop fabricated/non-profile links

  return {
    founder: d.person.trim(),
    exEmployer: factory || company,
    exDesignation: designation || 'Senior (unspecified)',
    moveType,
    currentBuilding: building,
    sector: (d.sector || '').trim() || 'Unspecified',
    linkedin: li,
    watchlisted,
    source: sourceUrl,
  };
}

// Apply the early-stage-raise gate to one extracted deal → normalized deal or null.
function normalizeDeal(d, sourceUrl) {
  if (!d || !d.company) return null;
  // Anti-hallucination: never trust a deal scraped off an aggregator/index/macro
  // page, and drop any record with placeholder / template content.
  if (UNRELIABLE_SOURCE_RE.test(sourceUrl || '')) return null;
  if (isFabricated({ name: d.company, founders: d.founders, backedBy: d.investors })) return null;
  const round = (d.round || '').toLowerCase();
  if (round && !/angel|pre[-\s]?seed|seed/.test(round)) return null; // early stage only
  if (!norm(d.company)) return null;
  return {
    company: d.company.trim(),
    amount: (d.amount || '').trim(),
    round: (d.round || 'Seed').trim(),
    sector: (d.sector || '').trim() || 'Consumer',
    investors: (d.investors || '').trim(),
    founders: (d.founders || '').trim(),
    description: (d.description || '').trim(),
    source: sourceUrl,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNAL 1 — founder-factory departures → building their own thing
// ─────────────────────────────────────────────────────────────────────────
const LEADERSHIP_MOVE_ITEM = {
  type: 'object',
  properties: {
    person: { type: 'string', description: 'Full name of the person' },
    company: { type: 'string', description: 'The large/well-known company they are leaving (e.g. Razorpay, Flipkart, Paytm)' },
    designation: { type: 'string', description: 'Their role/title at that company, e.g. VP Engineering, CBO, Co-Founder, Head of Product' },
    moveType: {
      type: 'string',
      enum: ['starting_own', 'stepped_down'],
      description: 'starting_own = explicitly leaving to start/found/build THEIR OWN new company or startup (stealth counts). stepped_down = senior person resigned/quit/stepped down but the article does NOT say they are starting their own company (next move unknown or unstated).',
    },
    newVenture: { type: 'string', description: 'For starting_own only: the name of THEIR OWN new company/venture, or "stealth <sector>" if unnamed. Empty for stepped_down.' },
    sector: { type: 'string', description: 'Sector of the new venture or the person\'s domain, e.g. Fintech, AI, D2C, SaaS. Empty if unknown.' },
    linkedin: { type: 'string', description: 'LinkedIn profile URL ONLY if explicitly shown, else empty. Never guess or construct one.' },
    seniorLeader: { type: 'boolean', description: 'true ONLY if this person held a SENIOR leadership role (C-suite, Founder/Co-Founder, President, VP/SVP/EVP, MD, Director, Head of X, GM, Partner, Chairman) at a large / well-known / well-funded company.' },
    confidence: { type: 'string', enum: ['explicit', 'implied'], description: 'explicit = the article clearly states this move happened. implied = you are inferring it.' },
  },
  required: ['person', 'company', 'moveType', 'seniorLeader', 'confidence'],
};

const LEADERSHIP_SCHEMA = {
  type: 'object',
  properties: {
    moves: {
      type: 'array',
      description: 'Senior leadership DEPARTURES at large/well-known companies: people leaving to start their own company, OR senior people who stepped down / resigned / quit. Exclude people merely joining another company, promotions, and new appointments. Empty array if none.',
      items: LEADERSHIP_MOVE_ITEM,
    },
  },
};

const LEADERSHIP_PROMPT =
  'Extract SENIOR LEADERSHIP DEPARTURES that THIS TEXT EXPLICITLY STATES, at large / well-known / well-funded ' +
  'companies. Two kinds only: (1) moveType="starting_own" — a senior leader leaving to start / found / build ' +
  'THEIR OWN new company or startup (stealth counts); give the new venture name. (2) moveType="stepped_down" ' +
  '— a senior leader who resigned / quit / stepped down where the text does NOT say what they do next. ' +
  'Only SENIOR leaders (C-suite, Founder/Co-Founder, President, VP/SVP/EVP, MD, Director, Head of X, GM, ' +
  'Partner, Chairman) at notable companies. EXCLUDE people simply joining another existing company, internal ' +
  'promotions, and new appointments/hires. Do NOT infer or use outside knowledge — set confidence="explicit" ' +
  'only when the text clearly states the move. Never fabricate a LinkedIn URL.';

async function scanDepartures() {
  log('SIGNAL 1 — senior leadership departures (starting own / stepped down)…');
  // Broad queries (any large company) carry the recall; a small priority subset
  // adds targeted depth on the highest-signal alumni pools.
  const queries = [
    'Indian startup senior executive steps down 2026',
    'Indian startup CXO resigns quits 2026',
    'India tech executive leaves to start own company 2026',
    'India startup founder steps down resigns 2026',
    'senior leader quits Indian unicorn to build own startup',
    'VP OR CTO OR CEO OR COO exit Indian startup 2026',
    'Indian startup leadership change executive departure 2026',
    'ex fintech executive quits to build stealth startup India',
    'startup CEO resignation India this month',
    'India tech CxO departure leadership reshuffle 2026',
  ];
  const PRIORITY = ['Razorpay', 'Flipkart', 'CRED', 'Swiggy', 'PhonePe', 'Meesho', 'Zerodha', 'Groww', 'Paytm', 'Zepto', 'Ola', 'Dream11'];
  for (const co of PRIORITY) {
    queries.push(`senior ${co} executive steps down OR quits to start own startup`);
  }

  // Discover candidate article URLs across all queries.
  const seenUrl = new Set();
  const candidates = [];
  const snippetSignals = [];
  for (const q of queries) {
    const results = await search(q);
    for (const r of results) {
      const url = r.url || '';
      if (!url || seenUrl.has(url)) continue;
      seenUrl.add(url);
      // Keep a lightweight record of every strong snippet as a discovery lead.
      const blob = `${r.title || ''} ${r.description || ''}`;
      if (/\b(quit|quits|stepped down|resigned|left|exits?|launch|found|founding|starts?|building|stealth)\b/i.test(blob)) {
        snippetSignals.push({ url, title: r.title || '', description: r.description || '' });
      }
      if (isNews(url)) candidates.push({ url, title: r.title || '' });
    }
    await sleep(300);
  }
  log(`  ${candidates.length} news candidates, ${snippetSignals.length} snippet leads`);

  // Scrape the top news candidates and extract structured departures.
  const found = [];
  const byName = new Map();
  let scraped = 0;
  for (const c of candidates) {
    if (scraped >= MAX_DEPARTURE_SCRAPES) break;
    scraped++;
    log(`  scrape (${scraped}/${MAX_DEPARTURE_SCRAPES}) ${c.url}`);
    const data = await scrapeJson(c.url, LEADERSHIP_PROMPT, LEADERSHIP_SCHEMA);
    const moves = (data && data.moves) || [];
    for (const d of moves) {
      const rec = normalizeMove(d, c.url);
      if (!rec) continue;
      const key = norm(rec.founder);
      if (byName.has(key)) continue;
      byName.set(key, true);
      found.push(rec);
    }
    await sleep(400);
  }

  const own = found.filter((f) => f.moveType === 'starting_own').length;
  log(`  extracted ${found.length} leadership departures (${own} building own, ${found.length - own} stepped down)`);
  return { found, snippetSignals };
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNAL 2 — angel / pre-seed raises (last 6–12 months)
// ─────────────────────────────────────────────────────────────────────────
const RAISE_SCHEMA = {
  type: 'object',
  properties: {
    deals: {
      type: 'array',
      description: 'Indian startups that recently raised an early-stage round.',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          amount: { type: 'string', description: 'e.g. $2.5M, ₹8 crore' },
          round: { type: 'string', description: 'Angel, Pre-Seed, Seed, etc.' },
          sector: { type: 'string', description: 'Fintech, AI, SaaS, D2C, Consumer, Healthtech, etc.' },
          investors: { type: 'string', description: 'Lead / notable investors, comma separated' },
          founders: { type: 'string', description: 'Founder names if mentioned' },
          description: { type: 'string', description: 'One line on what the company does' },
        },
        required: ['company'],
      },
    },
  },
};

const RAISE_PROMPT =
  'Extract Indian startups that recently raised an ANGEL, PRE-SEED, or SEED round. For each: company ' +
  'name, amount, round type, sector, lead/notable investors, founders, and a one-line description. ' +
  'Ignore Series A and later, debt, and secondary transactions.';

async function scanRaises() {
  log('SIGNAL 2 — angel / pre-seed raises…');
  const urls = new Set(RAISE_LISTING_URLS);

  // Augment listing pages with fresh search hits.
  const queries = [
    'India startup pre-seed funding raised 2026',
    'India startup angel round raised 2026',
    'Indian startup seed funding announced this month',
    'site:entrackr.com pre-seed OR angel funding India',
    'site:inc42.com startup raises seed funding India',
  ];
  for (const q of queries) {
    const results = await search(q);
    for (const r of results) {
      if (r.url && isNews(r.url)) urls.add(r.url);
    }
    await sleep(300);
  }

  const list = [...urls].slice(0, MAX_RAISE_SCRAPES);
  const byName = new Map();
  let scraped = 0;
  for (const url of list) {
    scraped++;
    log(`  scrape (${scraped}/${list.length}) ${url}`);
    const data = await scrapeJson(url, RAISE_PROMPT, RAISE_SCHEMA);
    const rows = (data && data.deals) || [];
    for (const d of rows) {
      const rec = normalizeDeal(d, url);
      if (!rec) continue;
      const key = norm(rec.company);
      if (byName.has(key)) continue;
      byName.set(key, rec);
    }
    await sleep(400);
  }
  const deals = [...byName.values()];
  log(`  extracted ${deals.length} early-stage raises`);
  return deals;
}

// ─────────────────────────────────────────────────────────────────────────
// RICH SIGNAL FEEDS — general news + social (inc42/buzz, X) that carry BOTH
// recent raises AND early market signals. Rendered full-page, extracted for
// both signals in a single scrape each.
// ─────────────────────────────────────────────────────────────────────────
const COMBINED_SCHEMA = {
  type: 'object',
  properties: {
    deals: RAISE_SCHEMA.properties.deals,
    moves: LEADERSHIP_SCHEMA.properties.moves,
  },
};

const COMBINED_PROMPT =
  'This is a startup-news / social feed with many short items. Extract TWO things. ' +
  '(1) deals: Indian startups that recently raised an ANGEL, PRE-SEED, or SEED round (company, amount, ' +
  'round, sector, investors, founders, one-line description) — ignore Series A+ , debt, and secondary. ' +
  '(2) moves: SENIOR leadership DEPARTURES at large companies — either moveType="starting_own" (a senior ' +
  'leader leaving to start their OWN new company; give the venture name) or moveType="stepped_down" (a ' +
  'senior leader who resigned/quit/stepped down with next move unstated). Only senior leaders; exclude ' +
  'people joining another company, promotions, and new hires. Do not infer; confidence="explicit" only. ' +
  'Never fabricate a LinkedIn URL. Empty arrays if nothing qualifies.';

async function scanRichSignals() {
  log('RICH SIGNALS — general news + social feeds…');
  const deals = [];
  const departures = [];
  for (const url of RICH_SIGNAL_URLS) {
    log(`  full-render scrape ${url}`);
    const data = await scrapeJson(url, COMBINED_PROMPT, COMBINED_SCHEMA, { fullRender: true, waitFor: 4000 });
    const dRows = (data && data.deals) || [];
    const pRows = (data && data.moves) || [];
    for (const d of dRows) { const rec = normalizeDeal(d, url); if (rec) deals.push(rec); }
    for (const p of pRows) { const rec = normalizeMove(p, url); if (rec) departures.push(rec); }
    await sleep(500);
  }
  log(`  rich feeds → ${deals.length} raises, ${departures.length} leadership moves`);
  return { deals, departures };
}

// ─────────────────────────────────────────────────────────────────────────
// Writers — merge into the tracker
// ─────────────────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// canonSector is imported from crawl-lib.js (word-boundary matched; the old
// includes('ai') here matched "hair"/"retail" and sent everything to Consumer).
function canonStage(round) {
  const r = (round || '').toLowerCase();
  if (r.includes('pre')) return 'Pre-Seed';
  if (r.includes('angel')) return 'Pre-Seed';
  return 'Seed';
}

function writeDepartures(found, snippetSignals, nowIso) {
  const file = path.join(DATA, 'departures.json');
  const existing = readJson(file, []);
  const byKey = new Map(existing.map((d) => [norm(d.founder), d]));
  let added = 0;
  let nextId = existing.reduce((m, d) => Math.max(m, parseInt((d.id || 'd0').slice(1)) || 0), 0);
  for (const d of found) {
    const key = norm(d.founder);
    if (byKey.has(key)) {
      // Refresh an existing record — and UPGRADE the signal if a stronger move
      // arrives (someone we logged as "stepped down" is now building their own).
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
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));

  // Snippet leads (unverified) — a lightweight parallel list for manual review.
  const leadFile = path.join(DATA, 'departure_leads.json');
  fs.writeFileSync(leadFile, JSON.stringify(snippetSignals.slice(0, 40), null, 2));
  return added;
}

function writeRaises(deals, nowIso) {
  const file = path.join(DATA, 'companies.json');
  const companies = readJson(file, []);
  const byName = new Map(companies.map((c) => [norm(c.name), c]));
  // Loose dedup: reject a new deal whose name is a substring (or superset) of an
  // existing company's — catches "Skyroot" vs "Skyroot Aerospace".
  const existsLoose = (n) => {
    if (byName.has(n)) return true;
    for (const k of byName.keys()) {
      if (k.length >= 5 && n.length >= 5 && (k.includes(n) || n.includes(k))) return true;
    }
    return false;
  };
  let added = 0;
  let nextId = companies.reduce((m, c) => Math.max(m, parseInt((c.id || 'c0').slice(1)) || 0), 0);
  const clean = (v) => {
    const s = (v || '').trim();
    return /^(undisclosed|n\/?a|unknown|not disclosed|-)?$/i.test(s) ? '' : s;
  };
  for (const d of deals) {
    const nName = norm(d.company);
    if (existsLoose(nName)) continue;
    nextId++;
    const rawSector = d.sector || '';
    const sector = canonSector(rawSector);
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
      subSector: rawSector,
      stage: canonStage(d.round),
      geography: 'India',
      hq: 'India',
      description: d.description || `${d.company} — early-stage ${sector} startup.`,
      founderPedigree: [],
      founders: d.founders ? d.founders.split(/,|&|and/).map((n) => ({ name: n.trim(), role: 'Founder' })).filter((f) => f.name) : [],
      signalType: 'Angel / Pre-Seed Raise',
      signalSource: `Firecrawl crawl — ${d.source}`,
      whyNow,
      whySparrow: `Early-stage ${sector} raise in India, surfaced by the live Firecrawl crawl. Fits the pre-seed / seed sourcing window.`,
      backedBy: investors ? investors.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3) : [],
      status: 'New Signal',
      createdAt: nowIso,
    };
    // Real, varied thesis score + urgency (not the old flat 60 / blanket High).
    rec.thesisScore = scoreCrawled(rec);
    rec.urgency = deriveUrgency(rec);
    byName.set(nName, rec);
    companies.push(rec);
    added++;
  }
  fs.writeFileSync(file, JSON.stringify(companies, null, 2));
  return added;
}

// ─────────────────────────────────────────────────────────────────────────
async function main() {
  const started = new Date();
  const nowIso = started.toISOString();
  log(`starting crawl @ ${nowIso}`);

  let departures = { found: [], snippetSignals: [] };
  let deals = [];
  let rich = { deals: [], departures: [] };
  try { departures = await scanDepartures(); } catch (e) { log('departures error:', e.message); }
  try { deals = await scanRaises(); } catch (e) { log('raises error:', e.message); }
  try { rich = await scanRichSignals(); } catch (e) { log('rich-signals error:', e.message); }

  // Merge rich-feed results into the main lists; the writers dedup by name.
  const allDeps = departures.found.concat(rich.departures);
  const allDeals = deals.concat(rich.deals);

  const depAdded = writeDepartures(allDeps, departures.snippetSignals, nowIso);
  const raiseAdded = writeRaises(allDeals, nowIso);

  // Update the scan-status file the dashboard reads.
  const lastScan = readJson(path.join(DATA, 'last_scan.json'), {});
  const merged = {
    ...lastScan,
    timestamp: nowIso,
    window: 'last ~12 months (qdr:y)',
    engine: 'firecrawl',
    sourcesChecked: ['news search', 'per-deal funding articles', 'inc42/buzz'],
    newCompanies: raiseAdded,
    newDepartures: depAdded,
    departuresFound: allDeps.length,
    raisesFound: allDeals.length,
  };
  fs.writeFileSync(path.join(DATA, 'last_scan.json'), JSON.stringify(merged, null, 2));

  // Regenerate data.js so the dashboard reflects the crawl.
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'regenerate-data-js.js')], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) { log('regenerate failed:', e.message); }

  const secs = Math.round((Date.now() - started.getTime()) / 1000);
  log(`DONE in ${secs}s — +${depAdded} departures, +${raiseAdded} raises`);
  console.log(JSON.stringify({ ok: true, depAdded, raiseAdded, departuresFound: allDeps.length, raisesFound: allDeals.length, seconds: secs }));
}

main().catch((e) => { console.error('[firecrawl-scan] fatal', e); process.exit(1); });
