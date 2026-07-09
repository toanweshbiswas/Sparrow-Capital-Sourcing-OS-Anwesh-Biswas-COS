// Firecrawl crawl logic — pure signal-gathering, no fs/network-destination
// assumptions. Shared by scripts/firecrawl-scan.js (local CLI, writes to
// data/*.json) and netlify/functions/firecrawl-scan-background.js (writes to
// Supabase). Takes an API key explicitly so each caller controls where it
// comes from (local .env vs Netlify environment variables).
'use strict';

const BASE = 'https://api.firecrawl.dev';

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

// High-yield funding-roundup pages worth scraping directly for raises.
const RAISE_LISTING_URLS = [
  'https://entrackr.com/tag/funding',
  'https://entrackr.com/tags/funding-news',
  'https://entrackr.com/monthly-funding-report',
  'https://entrackr.com/weekly-funding-report-weekly-funding-report',
  'https://inc42.com/tag/funding-galore/',
  'https://yourstory.com/tag/funding',
  'https://www.vccircle.com/category/startup',
];

// "Rich signal" feeds — general startup-news / social pages that carry BOTH
// fresh funding announcements AND early market signals (departures, launches).
// These are JS-heavy SPAs (incl. X/Twitter), so they must be scraped with the
// full page rendered (onlyMainContent:false + waitFor) or they come back empty.
// We run BOTH the raise and departure extractors against each.
const RICH_SIGNAL_URLS = [
  'https://inc42.com/buzz/',
  'https://inc42.com/tag/funding-galore/',
  'https://x.com/TheCEO_Magazine',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isNews = (u) => NEWS_DOMAINS.some((d) => hostOf(u).endsWith(d));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
function log(...a) { console.log(`[firecrawl-crawl]`, ...a); }

// Apply the leadership-move gates to one extracted record → normalized record
// or null. Shared by the news-article scan and the rich-signal-feed scan so
// every source gets the same anti-hallucination / relevance filtering.
function normalizeMove(d, sourceUrl) {
  if (!d || !d.person || !d.company) return null;
  const moveType = d.moveType === 'starting_own' ? 'starting_own' : d.moveType === 'stepped_down' ? 'stepped_down' : null;
  if (!moveType) return null;
  if (d.confidence !== 'explicit') return null; // explicit-only → controls hallucination
  const designation = (d.designation || '').trim();
  if (d.seniorLeader !== true) return null;
  if (designation && !SENIOR_TITLE_RE.test(designation)) return null;

  const company = d.company.trim();
  const cN = norm(company);
  const factory = FOUNDER_FACTORIES.find((f) => cN.includes(norm(f)) || norm(f).includes(cN));
  const watchlisted = !!factory;

  let building = '';
  if (moveType === 'starting_own') {
    building = (d.newVenture || '').trim();
    if (!building) return null;
    const bN = norm(building);
    if (bN === cN || bN.includes(cN) || cN.includes(bN)) return null;
  }

  let li = (d.linkedin || '').trim();
  if (li && !/linkedin\.com\/in\//i.test(li)) li = '';

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
  const round = (d.round || '').toLowerCase();
  if (round && !/angel|pre[-\s]?seed|seed/.test(round)) return null;
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

function makeCrawler(apiKey, opts = {}) {
  const MAX_DEPARTURE_SCRAPES = Number(opts.maxDepartureScrapes ?? process.env.SPARROW_DEP_SCRAPES ?? 16);
  const MAX_RAISE_SCRAPES = Number(opts.maxRaiseScrapes ?? process.env.SPARROW_RAISE_SCRAPES ?? 14);
  const SEARCH_LIMIT = Number(opts.searchLimit ?? process.env.SPARROW_SEARCH_LIMIT ?? 5);

  async function fc(endpoint, body, tries = 3) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const res = await fetch(`${BASE}${endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          await sleep(1500 * attempt);
          continue;
        }
        return await res.json();
      } catch (err) {
        if (attempt === tries) return { success: false, error: String(err) };
        await sleep(1200 * attempt);
      }
    }
    return { success: false, error: 'exhausted retries' };
  }

  async function search(query) {
    const out = await fc('/v2/search', { query, limit: SEARCH_LIMIT, tbs: 'qdr:y' });
    const results = (out && (out.data?.web || out.data)) || [];
    return Array.isArray(results) ? results : [];
  }

  async function scrapeJson(url, prompt, schema, opts2 = {}) {
    const body = {
      url,
      onlyMainContent: opts2.fullRender ? false : true,
      formats: [{ type: 'json', prompt, schema }],
    };
    if (opts2.fullRender) body.waitFor = opts2.waitFor || 3500;
    const out = await fc('/v2/scrape', body);
    if (!out || !out.success) return null;
    return out.data?.json || null;
  }

  async function scanDepartures() {
    log('SIGNAL 1 — senior leadership departures (starting own / stepped down)…');
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

    const seenUrl = new Set();
    const candidates = [];
    const snippetSignals = [];
    for (const q of queries) {
      const results = await search(q);
      for (const r of results) {
        const url = r.url || '';
        if (!url || seenUrl.has(url)) continue;
        seenUrl.add(url);
        const blob = `${r.title || ''} ${r.description || ''}`;
        if (/\b(quit|quits|stepped down|resigned|left|exits?|launch|found|founding|starts?|building|stealth)\b/i.test(blob)) {
          snippetSignals.push({ url, title: r.title || '', description: r.description || '' });
        }
        if (isNews(url)) candidates.push({ url, title: r.title || '' });
      }
      await sleep(300);
    }
    log(`  ${candidates.length} news candidates, ${snippetSignals.length} snippet leads`);

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

  async function scanRaises() {
    log('SIGNAL 2 — angel / pre-seed raises…');
    const urls = new Set(RAISE_LISTING_URLS);
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

  // Runs all three signal scans and returns the combined, still-unmerged lists.
  async function runCrawl() {
    let departures = { found: [], snippetSignals: [] };
    let deals = [];
    let rich = { deals: [], departures: [] };
    try { departures = await scanDepartures(); } catch (e) { log('departures error:', e.message); }
    try { deals = await scanRaises(); } catch (e) { log('raises error:', e.message); }
    try { rich = await scanRichSignals(); } catch (e) { log('rich-signals error:', e.message); }
    return {
      allDeps: departures.found.concat(rich.departures),
      allDeals: deals.concat(rich.deals),
      snippetSignals: departures.snippetSignals,
    };
  }

  return { scanDepartures, scanRaises, scanRichSignals, runCrawl };
}

module.exports = { makeCrawler, norm };
