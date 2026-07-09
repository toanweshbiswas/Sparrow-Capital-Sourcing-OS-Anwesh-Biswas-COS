/* ================================================================
   SPARROW CAPITAL SOURCING OS — app.js
   Lead Intelligence Engine · Signal-to-Conviction Pipeline
   v1.0 · July 2026
   ================================================================ */
'use strict';

// ══════════════════════════════════════════════════════════════════
// 1. CONFIGURATION
// ══════════════════════════════════════════════════════════════════
const CONFIG = {
  version: '1.0',
  thesis: {
    geography:  'India',
    stages:     ['Pre-Seed', 'Seed'],
    sectors:    ['Fintech', 'B2B', 'AI', 'Consumer'],
    ticketMin:  1000000,
    ticketMax:  2000000,
    pedigree:   ['IIT', 'IIM', 'NIT', 'BITS', 'Stanford', 'ISB', 'XLRI',
                 'Ex-Flipkart','Ex-CRED','Ex-Razorpay','Ex-PhonePe','Ex-Zomato',
                 'Ex-Swiggy','Ex-Meesho','Ex-Ola','Ex-Paytm','Ex-Byju\'s',
                 'Ex-Unacademy','Ex-Groww','Ex-Zerodha','Ex-McKinsey','Ex-BCG',
                 'Ex-Goldman','Ex-JP Morgan','Ex-Google','Ex-Microsoft','Ex-Amazon']
  },
  pipeline_stages: ['New Signal','Researching','Outreach Sent','In Conversation','Pass'],
};

// ══════════════════════════════════════════════════════════════════
// 2–4. SEED DATA — now loaded from data.js (generated from data/*.json)
// SEED_COMPANIES, SEED_INVESTORS, SEED_VCS, LAST_SCAN are globals defined
// in data.js, which must be loaded via <script> before this file.
// Regenerate data.js with: node scripts/regenerate-data-js.js
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// 5. STATE MANAGEMENT
// ══════════════════════════════════════════════════════════════════
const State = {
  companies: [],
  investors: SEED_INVESTORS,
  vcs: SEED_VCS,
  filters: { sector:'all', urgency:'all', stage:'all', search:'', signalType:'all' },
  settings: { geminiKey:'', googleKey:'', notionKey:'', notionDbId:'' },
  currentView: 'dashboard',
  selectedOutreachCompany: null,
  selectedEmailTab: 'cold',
  draggedId: null,

  init() {
    // data.js (regenerated from the real tracker after every scan) is always
    // authoritative for WHICH companies exist. Local storage may only carry
    // forward user edits (status/notes) for companies that still exist there —
    // it must never let a removed/purged company persist forever just because
    // a past session once saved it. Start from SEED_COMPANIES every time and
    // layer local edits on top, rather than starting from local storage and
    // only ever adding to it.
    let existingById = new Map();
    const saved = localStorage.getItem('sparrow_crm');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        existingById = new Map((parsed.companies || []).map(c => [c.id, c]));
      } catch (e) {
        existingById = new Map();
      }
    }

    // Fields the user can edit locally that must survive reloads (data.js stays
    // authoritative for everything else). Includes the follow-up / cadence state.
    const LOCAL_FIELDS = ['status', 'notes', 'nextAction', 'nextActionDue', 'lastTouch', 'owner', 'touches'];
    this.companies = SEED_COMPANIES.map(sc => {
      const local = existingById.get(sc.id);
      if (!local) return { ...sc };
      const merged = { ...sc };
      LOCAL_FIELDS.forEach(f => { if (local[f] !== undefined) merged[f] = local[f]; });
      return merged;
    });

    const savedSettings = localStorage.getItem('sparrow_settings');
    if (savedSettings) {
      try { this.settings = JSON.parse(savedSettings); } catch(e) {}
    }

    this.save();
  },

  save() {
    localStorage.setItem('sparrow_crm', JSON.stringify({ companies: this.companies }));
  },

  saveSettings() {
    localStorage.setItem('sparrow_settings', JSON.stringify(this.settings));
  },

  getCompanies() {
    return this.companies;
  },

  getPipelineData() {
    const pipeline = {};
    CONFIG.pipeline_stages.forEach(s => { pipeline[s] = []; });
    this.companies.forEach(c => {
      const stage = c.status || 'New Signal';
      if (pipeline[stage]) pipeline[stage].push(c);
    });
    return pipeline;
  },
};

// ══════════════════════════════════════════════════════════════════
// 6. CRM ENGINE
// ══════════════════════════════════════════════════════════════════
const CRM = {
  updateStatus(id, status) {
    const c = State.companies.find(c => c.id === id);
    if (c) {
      c.status = status;
      State.save();
      Toast.show(`${c.name} moved to "${status}"`, 'success');
    }
  },

  updateNotes(id, notes) {
    const c = State.companies.find(c => c.id === id);
    if (c) { c.notes = notes; State.save(); }
  },

  addCompany(data) {
    const id = 'c' + Date.now();
    const scored = Scorer.score(data);
    const company = {
      ...data, id, thesisScore: scored.total,
      thesisBreakdown: scored.breakdown,
      addedDate: new Date().toISOString().split('T')[0],
      status: 'New Signal', notes: '',
    };
    State.companies.unshift(company);
    State.save();
    Toast.show(`${company.name} added to Signal Feed`, 'success');
    return company;
  },

  deleteCompany(id) {
    const idx = State.companies.findIndex(c => c.id === id);
    if (idx !== -1) {
      const name = State.companies[idx].name;
      State.companies.splice(idx, 1);
      State.save();
      Toast.show(`${name} removed`, 'info');
    }
  },

  getFilteredCompanies() {
    const f = State.filters;
    return State.companies.filter(c => {
      if (f.sector !== 'all' && c.sector !== f.sector) return false;
      if (f.urgency !== 'all' && c.urgency !== f.urgency) return false;
      if (f.stage !== 'all' && c.stage !== f.stage) return false;
      if (f.signalType !== 'all' && c.signalType !== f.signalType) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        const searchable = `${c.name} ${c.sector} ${c.description} ${(c.founderPedigree||[]).join(' ')} ${c.signalType}`.toLowerCase();
        if (!searchable.includes(q)) return false;
      }
      return true;
    });
  },
};

// ══════════════════════════════════════════════════════════════════
// 6b. FOLLOW-UP & CADENCE ENGINE
// Keeps every live deal moving: computes who's owed a touch, tracks the next
// action + due date, and logs touches (resetting the cadence). Follow-up state
// lives on the company record and persists via State.save() (localStorage).
// ══════════════════════════════════════════════════════════════════
// Days between touches, by pipeline stage. Fresh signals get chased fastest.
const CADENCE_DAYS = {
  'New Signal': 3,
  'Researching': 5,
  'Outreach Sent': 4,
  'In Conversation': 7,
  'Pass': null,
};
const TOUCH_CHANNELS = ['Email', 'Call', 'LinkedIn', 'Meeting', 'Intro', 'Note'];

function _today0() { const d = new Date(); d.setHours(0,0,0,0); return d; }
function _parseDate(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function _daysFromToday(d) { const x = new Date(d); x.setHours(0,0,0,0); return Math.round((x - _today0()) / 86400000); }
function _relDays(delta) {
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta === -1) return '1 day ago';
  return delta < 0 ? `${-delta} days ago` : `in ${delta} days`;
}

const Followups = {
  cadence(status) { const c = CADENCE_DAYS[status]; return c == null ? null : c; },

  // Follow-up state for one company.
  info(c) {
    if ((c.status || 'New Signal') === 'Pass') return { tracked: false };
    const cad = this.cadence(c.status || 'New Signal') ?? 4;
    const last = _parseDate(c.lastTouch);
    const explicit = _parseDate(c.nextActionDue);
    let due, neverTouched = false;
    if (explicit) {
      due = explicit;
    } else if (last) {
      due = new Date(last); due.setDate(due.getDate() + cad);
    } else {
      neverTouched = true;
      const created = _parseDate(c.createdAt || c.addedDate) || _today0();
      due = new Date(created); due.setDate(due.getDate() + Math.min(cad, 3));
    }
    const delta = _daysFromToday(due);
    const state = delta < 0 ? 'overdue' : (delta <= 2 ? 'due' : 'upcoming');
    // Attention bucket: 0 overdue · 1 awaiting first touch · 2 due soon · 3 upcoming.
    let bucket;
    if (state === 'overdue') bucket = 0;
    else if (neverTouched) bucket = 1;
    else if (state === 'due') bucket = 2;
    else bucket = 3;
    return { tracked: true, due, delta, state, neverTouched, cadence: cad, last, bucket };
  },

  // Active deals needing attention, ranked most-urgent first.
  list({ owner = 'all', status = 'all', overdueOnly = false } = {}) {
    const rows = State.companies
      .map(c => ({ c, info: this.info(c) }))
      .filter(r => r.info.tracked)
      .filter(r => status === 'all' || (r.c.status || 'New Signal') === status)
      .filter(r => {
        if (owner === 'all') return true;
        if (owner === 'unassigned') return !r.c.owner;
        return r.c.owner === owner;
      })
      .filter(r => !overdueOnly || r.info.bucket === 0);
    const urg = (c) => c.urgency === 'High' ? 0 : c.urgency === 'Medium' ? 1 : 2;
    rows.sort((a, b) =>
      a.info.bucket - b.info.bucket ||
      a.info.delta - b.info.delta ||
      urg(a.c) - urg(b.c) ||
      (b.c.thesisScore || 0) - (a.c.thesisScore || 0));
    return rows;
  },

  counts() {
    let overdue = 0, noTouch = 0, dueSoon = 0;
    State.companies.forEach(c => {
      const i = this.info(c);
      if (!i.tracked) return;
      if (i.bucket === 0) overdue++;
      else if (i.bucket === 1) noTouch++;
      else if (i.bucket === 2) dueSoon++;
    });
    return { overdue, noTouch, dueSoon, needsAttention: overdue + noTouch + dueSoon };
  },

  logTouch(id, channel, note, alsoAction) {
    const c = State.companies.find(x => x.id === id); if (!c) return;
    const now = new Date();
    c.lastTouch = now.toISOString().split('T')[0];
    c.touches = Array.isArray(c.touches) ? c.touches : [];
    c.touches.unshift({ at: now.toISOString(), channel: channel || 'Note', note: note || '', by: c.owner || 'You' });
    const cad = this.cadence(c.status || 'New Signal') ?? 4;
    const nd = new Date(); nd.setDate(nd.getDate() + cad);
    c.nextActionDue = nd.toISOString().split('T')[0];
    if (alsoAction) c.nextAction = alsoAction;
    State.save();
    Toast.show(`Touch logged — ${c.name}. Next due in ${cad}d.`, 'success');
  },

  setNextAction(id, action, dueISO) {
    const c = State.companies.find(x => x.id === id); if (!c) return;
    if (action !== undefined) c.nextAction = action;
    if (dueISO) c.nextActionDue = dueISO;
    State.save();
  },

  setOwner(id, owner) {
    const c = State.companies.find(x => x.id === id); if (!c) return;
    c.owner = (owner || '').trim();
    State.save();
  },

  owners() {
    return [...new Set(State.companies.map(c => c.owner).filter(Boolean))].sort();
  },
};

// ══════════════════════════════════════════════════════════════════
// 7. THESIS SCORER
// ══════════════════════════════════════════════════════════════════
const Scorer = {
  score(company) {
    let geo = 0, stage = 0, sector = 0, pedigree = 0, signal = 0;

    // Geography
    if ((company.geography || '').toLowerCase().includes('india')) geo = 30;

    // Stage
    if (['Pre-Seed','Seed'].includes(company.stage)) stage = 25;
    else if (company.stage === 'Series A') stage = 10;

    // Sector
    const s = company.sector;
    if (s === 'Fintech') sector = 20;
    else if (s === 'AI') sector = 19;
    else if (s === 'B2B') sector = 17;
    else if (s === 'Consumer') sector = 12;

    // Pedigree
    const peds = (company.founderPedigree || []).join(' ');
    if (peds.match(/IIT|IIM/)) pedigree += 6;
    if (peds.match(/NIT|BITS|ISB/)) pedigree += 3;
    if (peds.match(/Ex-CRED|Ex-Razorpay|Ex-PhonePe|Ex-Flipkart|Ex-Zerodha/)) pedigree += 6;
    if (peds.match(/Ex-Swiggy|Ex-Zomato|Ex-Meesho|Ex-Ola|Ex-Paytm/)) pedigree += 3;
    if (peds.match(/Ex-Goldman|Ex-McKinsey|Ex-BCG|Ex-Google|Ex-Microsoft/)) pedigree += 3;
    pedigree = Math.min(pedigree, 15);

    // Signal
    if (company.signalType === 'YC Alumni') signal = 5;
    else if (['Founding Engineer Hire','Ex-Employer Trend'].includes(company.signalType)) signal = 3;
    else if (['VC Portfolio','Shark Tank Funded'].includes(company.signalType)) signal = 5;
    else signal = 2;

    const total = Math.min(geo + stage + sector + pedigree + signal, 100);
    return { total, breakdown: {Geography:geo,Stage:stage,Sector:sector,Pedigree:pedigree,Signal:signal} };
  },
};

// ══════════════════════════════════════════════════════════════════
// 8. OUTREACH GENERATOR
// ══════════════════════════════════════════════════════════════════
const Outreach = {
  getColdEmail(company) {
    const founder = (company.founders && company.founders[0]) ? company.founders[0].name : 'Founder';
    const firstName = founder.split(' ')[0] !== '[Undisclosed]' && founder.split(' ')[0] !== '[Ex-CRED' ? founder.split(' ')[0] : 'Hi';
    const pedigree = (company.founderPedigree || []).filter(p => !p.startsWith('Ex-')).join('/');
    const exCo = (company.founderPedigree || []).filter(p => p.startsWith('Ex-')).map(p => p.replace('Ex-','')).join('/');
    const subject = `Sparrow Capital // ${company.name} — We'd Love to Connect`;

    const body = `${firstName},

I came across ${company.name} while tracking ${company.signalType === 'YC Alumni' ? `YC ${company.signalSource.replace('YCombinator ','')} companies` : company.signalSource} and immediately flagged you as a high-conviction opportunity for Sparrow Capital.

What caught my attention: ${company.whyNow}

At Sparrow, we write $1–2M Seed/Pre-Seed checks into India-first Fintech, B2B SaaS, AI, and Consumer companies. Your ${pedigree}${exCo ? ` + ${exCo}` : ''} background is exactly the pedigree we look for.

**Something useful for you:** ${company.reciprocityHook}

Would love 20 minutes to learn what you're building and share how Sparrow can add value beyond the check.

Happy to work around your schedule — what does next week look like?

Best,
[Your Name]
Sparrow Capital
@sparrowcap | sparrowcapital.in`;

    return { subject, body, to: `${founder} <founder@${company.name.toLowerCase().replace(/\s+/g,'')}.com>` };
  },

  getWarmIntroEmail(company) {
    const connector = company.backedBy && company.backedBy.length ? company.backedBy[0] : 'mutual contact';
    const subject = `Intro Request: Sparrow Capital <> ${company.name}`;
    const body = `Hi [Connector Name],

Hope you're doing well! I wanted to reach out about ${company.name} — a company I've been tracking closely.

Given your connection to them via ${connector}, I was wondering if you could make a warm introduction to the founding team.

Sparrow Capital writes $1–2M Seed/Pre-Seed checks into India-first Fintech, B2B, AI, and Consumer startups. ${company.name} is exactly the profile we're looking to back.

Why I think this would be valuable for both sides:
• ${company.whySparrow}
• We've already done initial research and have ${company.reciprocityHook}

If you're comfortable, even a 3-line intro email would be incredibly valuable.

Thanks in advance — happy to return the favor anytime!

Best,
[Your Name]
Sparrow Capital`;

    return { subject, body, to: `[Connector Name] <connector@email.com>` };
  },

  getFollowUpEmail(company) {
    const founder = (company.founders && company.founders[0]) ? company.founders[0].name.split(' ')[0] : 'Hi';
    const subject = `Re: ${company.name} × Sparrow Capital — Quick Follow-Up`;
    const body = `${founder},

Following up on my note from [X days ago] — just wanted to bump this in case it got buried!

Since I last reached out, I've done more research on ${company.name} and I'm even more convinced about the opportunity. ${company.whyNow}

Happy to jump on a quick 15-min call this week — or if you'd prefer, I can share a quick one-pager on how Sparrow approaches investments in your space.

No pressure either way. Just want to make sure we stay connected.

Best,
[Your Name]
Sparrow Capital`;

    return { subject, body, to: `${founder} <founder@${company.name.toLowerCase().replace(/\s+/g,'')}.com>` };
  },

  getEmail(company, type) {
    if (type === 'warm') return this.getWarmIntroEmail(company);
    if (type === 'followup') return this.getFollowUpEmail(company);
    return this.getColdEmail(company);
  },
};

// ══════════════════════════════════════════════════════════════════
// 9. EXPORT ENGINE
// ══════════════════════════════════════════════════════════════════
const Export = {
  toCSV() {
    const companies = State.getCompanies();
    const headers = ['Name','Website','Sector','Stage','Geography','HQ','Signal Type','Urgency','Thesis Score','Status','Backed By','Funding Round','Added Date','Why Now','Recommended Action','Notes'];
    const rows = companies.map(c => [
      c.name, c.website || '', c.sector, c.stage, c.geography, c.hq || '',
      c.signalType, c.urgency, c.thesisScore, c.status,
      (c.backedBy || []).join('; '), c.fundingRound || '', c.addedDate,
      `"${(c.whyNow || '').replace(/"/g,'""')}"`,
      `"${(c.recommendedAction || '').replace(/"/g,'""')}"`,
      `"${(c.notes || '').replace(/"/g,'""')}"`,
    ]);

    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sparrow-pipeline-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    Toast.show(`Exported ${companies.length} companies to CSV`, 'success');
  },

  copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      Toast.show('Copied to clipboard!', 'success');
    }).catch(() => {
      Toast.show('Copy failed — use Ctrl+A to select', 'error');
    });
  },
};

// ══════════════════════════════════════════════════════════════════
// 10. SCANNER — Live Data Fetcher
// ══════════════════════════════════════════════════════════════════
// Scanning happens outside the browser: Claude Code runs /scan-raises (and
// /company-brief, /follow-ups) against real public sources, writes results to
// data/*.json, then regenerates data.js via scripts/regenerate-data-js.js.
// This dashboard has no backend and embeds no API key, so it cannot trigger
// that run itself — "Scan Now" reports the truth about the last real run
// instead of faking one.
const Scanner = {
  describeLastScan() {
    const ls = (typeof LAST_SCAN !== 'undefined' && LAST_SCAN) || null;
    if (!ls || !ls.timestamp) {
      return {
        label: 'Never scanned',
        detail: 'No scan has run yet. Run <code>/scan-raises</code> in Claude Code to populate real signal.',
      };
    }
    const when = new Date(ls.timestamp);
    const sources = (ls.sourcesChecked || []).join(', ') || 'none recorded';
    return {
      label: `Last scan: ${when.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
      detail: `Window: ${ls.window || '—'} · New companies: ${ls.newCompanies ?? 0} · Sources checked: ${sources}`,
    };
  },

  updateLastScanLabel() {
    const el = document.getElementById('last-scan');
    if (el) el.textContent = this.describeLastScan().label;
  },

  // true when this page was opened as a local file or from the local
  // scan-server.js (http://localhost:8787) — as opposed to a hosted deploy
  // (e.g. the Netlify site), where "run node scripts/scan-server.js and
  // reload this URL" isn't actionable advice.
  _isLocalContext() {
    return location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  },

  showNoServerModal(opts = {}) {
    const feature = opts.feature || 'scan'; // 'scan' (full /scan-raises agent) | 'crawl' (Firecrawl)
    const { label, detail } = this.describeLastScan();
    const local = this._isLocalContext();
    const code = (s) => `<div style="background:var(--bg-elevated,rgba(255,255,255,0.04));border-radius:8px;padding:10px 12px;font-size:12px;font-family:'JetBrains Mono',monospace;margin-bottom:12px;">${s}</div>`;
    const p = (s) => `<p style="color:var(--text-muted);font-size:13px;line-height:1.6;margin:12px 0;">${s}</p>`;

    let title, body;
    if (feature === 'crawl') {
      if (local) {
        title = "Local scan server isn't running";
        body = p(`"Crawl Web" runs a fast Firecrawl-based sweep for founder departures &amp; angel/pre-seed
          raises through a small local server — but it's not reachable right now. Start it from the
          project folder with:`) + code('node scripts/scan-server.js') +
          p(`Then open the URL it prints (default <code>http://localhost:8787</code>) instead of this
          file directly, and click Crawl Web again.`);
      } else {
        title = "Crawl backend isn't configured on this deployment";
        body = p(`"Crawl Web" runs through a Netlify Function that talks to Firecrawl and Supabase, but
          it isn't reachable right now. If you just deployed this, make sure <code>FIRECRAWL_API_KEY</code>,
          <code>SUPABASE_URL</code>, and <code>SUPABASE_SERVICE_ROLE_KEY</code> are set as Netlify
          environment variables (Site settings → Environment variables) and redeploy.`);
      }
    } else {
      if (local) {
        title = "Local scan server isn't running";
        body = p(`"Scan Now" triggers a real <code>/scan-raises</code> run in Claude Code (a wide sweep —
          sector, source, investor-watchlist, accelerator, regional, and hiring-signal searches,
          typically 5–10+ minutes, real usage against your account) through a small local server —
          but it's not reachable right now. Start it from the project folder with:`) +
          code('node scripts/scan-server.js') +
          p(`Then open the URL it prints (default <code>http://localhost:8787</code>) instead of this
          file directly, and click Scan Now again.`);
      } else {
        title = "Full scan only runs on your own machine";
        body = p(`"Scan Now" drives a real <code>/scan-raises</code> agent run (5–10+ minutes) through your
          logged-in Claude Code CLI — a hosted site can't do that on your behalf. Run it locally instead:`) +
          code('node scripts/scan-server.js') +
          p(`Then open <code>http://localhost:8787</code> on your own machine and click Scan Now there.
          On this hosted dashboard, use <strong>Crawl Web</strong> instead — that fast crawl runs from here.`);
      }
    }

    Modal.open(`
      <div class="modal-company-name">${title}</div>
      ${body}
      <div style="background:var(--bg-elevated,rgba(255,255,255,0.04));border-radius:8px;padding:10px 12px;font-size:12px;color:var(--text-muted);">
        <strong>${label}</strong><br>${detail}
      </div>
    `);
  },

  async pingEndpoint(path) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      return res.ok;
    } catch (e) {
      return false;
    }
  },

  async pingServer() { return this.pingEndpoint('/status'); },
  async pingFirecrawl() { return this.pingEndpoint('/firecrawl-status'); },

  // Firecrawl crawl — fast, key-based (no Claude account usage). Sweeps Indian
  // startup press for (1) founder-factory departures and (2) angel/pre-seed
  // raises, writes to the tracker, regenerates data.js, then reloads.
  async runFirecrawl() {
    if (!(await this.pingFirecrawl())) {
      this.showNoServerModal({ feature: 'crawl' });
      return;
    }
    const btn = document.getElementById('crawl-btn');
    const status = document.getElementById('scan-status');
    const scanText = document.getElementById('scan-text');
    btn.disabled = true;
    btn.textContent = 'Crawling…';
    status.classList.remove('hidden');
    scanText.textContent = 'Firecrawl is crawling Indian startup press for founder departures & angel/pre-seed raises — usually 1–3 minutes…';
    try {
      const startRes = await fetch('/firecrawl-scan', { method: 'POST' });
      if (startRes.status === 409) {
        Toast.show('A crawl is already running — waiting for it to finish.', 'info');
      } else if (!startRes.ok) {
        throw new Error(`Server returned ${startRes.status}`);
      }
    } catch (e) {
      Toast.show('Could not start the crawl — check the terminal running scan-server.js.', 'error');
      btn.disabled = false;
      btn.innerHTML = 'Crawl Web';
      status.classList.add('hidden');
      return;
    }
    this._pollFirecrawl();
  },

  async _pollFirecrawl() {
    let state;
    try {
      const res = await fetch('/firecrawl-status', { cache: 'no-store' });
      state = await res.json();
    } catch (e) {
      Toast.show('Lost connection to the crawl server.', 'error');
      this._resetCrawlButton();
      return;
    }
    if (state.running) {
      setTimeout(() => this._pollFirecrawl(), 3000);
      return;
    }
    this._resetCrawlButton();
    if (state.error) {
      Toast.show(`Crawl failed: ${state.error}`, 'error');
    } else if (state.exitCode !== 0) {
      Toast.show(`Crawl exited with code ${state.exitCode} — check data/firecrawl_log.txt`, 'error');
    } else {
      const s = state.summary || {};
      Toast.show(`Crawl complete — +${s.depAdded ?? 0} departures, +${s.raiseAdded ?? 0} raises. Reloading…`, 'success');
      setTimeout(() => location.reload(), 1400);
    }
  },

  _resetCrawlButton() {
    const btn = document.getElementById('crawl-btn');
    const status = document.getElementById('scan-status');
    if (status) status.classList.add('hidden');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 001.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clip-rule="evenodd"/></svg> Crawl Web';
    }
  },

  async runScan() {
    if (!(await this.pingServer())) {
      this.showNoServerModal();
      return;
    }

    const btn = document.getElementById('scan-btn');
    const status = document.getElementById('scan-status');
    const scanText = document.getElementById('scan-text');

    btn.disabled = true;
    btn.textContent = 'Scanning...';
    status.classList.remove('hidden');
    scanText.textContent = 'Running a wide sweep (sector, source, investor, accelerator, regional, hiring-signal) — this can take 5–10+ minutes...';

    try {
      const startRes = await fetch('/scan', { method: 'POST' });
      if (startRes.status === 409) {
        Toast.show('A scan is already running — waiting for it to finish.', 'info');
      } else if (!startRes.ok) {
        throw new Error(`Server returned ${startRes.status}`);
      }
    } catch (e) {
      Toast.show('Could not start the scan — check the terminal running scan-server.js.', 'error');
      btn.disabled = false;
      status.classList.add('hidden');
      return;
    }

    this._poll();
  },

  async _poll() {
    let state;
    try {
      const res = await fetch('/status', { cache: 'no-store' });
      state = await res.json();
    } catch (e) {
      Toast.show('Lost connection to the scan server.', 'error');
      this._resetButton();
      return;
    }

    if (state.running) {
      setTimeout(() => this._poll(), 3000);
      return;
    }

    this._resetButton();
    if (state.error) {
      Toast.show(`Scan failed: ${state.error}`, 'error');
    } else if (state.exitCode !== 0) {
      Toast.show(`Scan process exited with code ${state.exitCode} — check data/scan_log.txt`, 'error');
    } else {
      Toast.show('Scan complete — reloading with new signal...', 'success');
      setTimeout(() => location.reload(), 1200);
    }
  },

  _resetButton() {
    const btn = document.getElementById('scan-btn');
    const status = document.getElementById('scan-status');
    status.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg> Scan Now';
  },
};

// ══════════════════════════════════════════════════════════════════
// 11. TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════
const Toast = {
  show(message, type='info', duration=3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const icons = { success:'✓', error:'✗', info:'i' };
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span style="font-weight:700;font-size:15px;">${icons[type]||'i'}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
};

// ══════════════════════════════════════════════════════════════════
// 12. MODAL SYSTEM
// ══════════════════════════════════════════════════════════════════
const Modal = {
  open(html) {
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  },

  close(e) {
    if (e && e.target !== document.getElementById('modal-overlay') && e.target !== document.getElementById('modal-close-btn') && !e.target.closest('#modal-close-btn')) return;
    document.getElementById('modal-overlay').classList.add('hidden');
    document.body.style.overflow = '';
  },

  showCompanyDetail(companyId) {
    const c = State.companies.find(x => x.id === companyId);
    if (!c) return;

    const urgencyClass = `tag tag-urgency-${c.urgency ? c.urgency.toLowerCase() : 'medium'}`;
    const sectorClass = `tag tag-sector-${(c.sector||'').toLowerCase()}`;
    const pedigreeHtml = (c.founderPedigree || []).map(p => `<span class="pedigree-tag">${p}</span>`).join('');
    const backedHtml = (c.backedBy || []).map(b => `<span class="portfolio-tag">${b}</span>`).join('');
    const breakdownHtml = Object.entries(c.thesisBreakdown || {}).map(([k,v]) => `
      <div class="mini-bar-row">
        <span class="mini-bar-label">${k}</span>
        <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${Math.round(v/(k==='Geography'?30:k==='Stage'?25:k==='Sector'?20:k==='Pedigree'?15:5)*100)}%"></div></div>
        <span class="mini-bar-val">${v}</span>
      </div>`).join('');

    const statusOptions = CONFIG.pipeline_stages.map(s =>
      `<option value="${s}" ${c.status === s ? 'selected' : ''}>${s}</option>`
    ).join('');

    Modal.open(`
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:4px;">
        <div style="flex:1;">
          <div class="modal-company-name">${c.name}</div>
          <div style="font-size:12px;color:var(--text-muted);">${c.hq || c.geography} · ${c.sector} · ${c.stage}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:28px;font-weight:900;color:var(--gold);font-family:'JetBrains Mono',monospace;">${c.thesisScore}</div>
          <div style="font-size:10px;color:var(--text-muted);">Thesis Score</div>
        </div>
      </div>

      <div class="card-tags" style="margin:12px 0;">
        <span class="${urgencyClass}">${c.urgency} Urgency</span>
        <span class="${sectorClass}">${c.sector}</span>
        <span class="tag tag-signal">${c.signalType}</span>
        <span class="tag tag-stage">${c.stage}</span>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">📋 Problem / Solution</div>
        <div style="font-size:13.5px;color:var(--text-secondary);line-height:1.65;">${c.description}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">⚡ Why Now — The Catalyst</div>
        <div class="modal-why-box">${c.whyNow}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">🎯 Why Sparrow?</div>
        <div class="modal-why-box" style="border-color:rgba(59,130,246,0.2);background:rgba(59,130,246,0.05);">${c.whySparrow}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">🧠 Memo-Informed Read <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--text-muted);font-size:11px;">— from the Playbook</span></div>
        <div class="memo-lens">
          ${memoLens(c).map(t => `<div class="lens-row"><span class="lens-ico ${t.ok===true?'ok':t.ok===false?'gap':'ask'}">${t.ok===true?'✓':t.ok===false?'!':'?'}</span><div><span class="lens-p">${t.p}</span> ${t.t}</div></div>`).join('')}
        </div>
        <button class="btn btn-ghost btn-xs" style="margin-top:8px;" onclick="Modal.close({target:document.getElementById('modal-overlay')});Router.navigate('memos')">Open the Memo Playbook →</button>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">🏆 Founder Pedigree</div>
        <div class="card-pedigree">${pedigreeHtml}</div>
        ${c.founders ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">${c.founders.map(f=>`${f.name} — ${f.role}`).join(' · ')}</div>` : ''}
      </div>

      <div class="modal-section">
        <div class="modal-section-title">💸 Funding & Backers</div>
        <div class="modal-field">
          <span class="modal-field-label">Round</span>
          <span class="modal-field-val">${c.fundingRound || 'Undisclosed'}</span>
        </div>
        <div class="portfolio-companies">${backedHtml || '<span style="color:var(--text-muted);font-size:12px;">No external backers yet</span>'}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">📊 Thesis Score Breakdown</div>
        <div class="mini-bar-chart">${breakdownHtml}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">🚀 Recommended Action</div>
        <div style="font-size:13px;color:var(--urgent-low);background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.15);padding:10px 12px;border-radius:8px;">${c.recommendedAction}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">🎁 Reciprocity Hook</div>
        <div style="font-size:12.5px;color:var(--text-secondary);font-style:italic;">${c.reciprocityHook || 'None defined'}</div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">📝 CRM Status & Notes</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <select class="status-select" id="modal-status-select" onchange="CRM.updateStatus('${c.id}', this.value)">${statusOptions}</select>
          <button class="btn btn-secondary btn-sm" onclick="Outreach.openOutreachFor('${c.id}')">✉ Generate Email</button>
        </div>
        <textarea class="notes-textarea" id="modal-notes" placeholder="Add notes about this company..."
          onblur="CRM.updateNotes('${c.id}', this.value)">${c.notes || ''}</textarea>
      </div>

      <div class="modal-action-row">
        ${c.website ? `<a href="${c.website}" target="_blank" class="btn btn-ghost btn-sm">🔗 Website</a>` : ''}
        <button class="btn btn-primary btn-sm" onclick="Outreach.openOutreachFor('${c.id}');Modal.close({target:document.getElementById('modal-overlay')})">✉ Open Outreach Lab</button>
        <button class="btn btn-danger btn-sm" onclick="if(confirm('Remove ${c.name}?')){CRM.deleteCompany('${c.id}');Modal.close({target:document.getElementById('modal-overlay')});Router.navigate(State.currentView);}">🗑 Remove</button>
      </div>
    `);
  },
};

// Helper for Outreach
Outreach.openOutreachFor = function(companyId) {
  State.selectedOutreachCompany = companyId;
  Router.navigate('outreach');
};

// ══════════════════════════════════════════════════════════════════
// 13. UI HELPERS
// ══════════════════════════════════════════════════════════════════
function scoreRingSVG(score) {
  const r = 18, circ = 2 * Math.PI * r;
  const filled = circ - (circ * score / 100);
  const color = score >= 80 ? '#F59E0B' : score >= 65 ? '#3B82F6' : '#475569';
  return `<svg width="44" height="44" viewBox="0 0 44 44">
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="4"/>
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="${color}" stroke-width="4"
      stroke-dasharray="${circ}" stroke-dashoffset="${filled}" stroke-linecap="round"
      transform="rotate(-90 22 22)" style="transition:stroke-dashoffset 1s ease"/>
  </svg>`;
}

function renderCompanyCard(c, compact=false) {
  const urgencyClass = `tag tag-urgency-${(c.urgency||'medium').toLowerCase()}`;
  const sectorClass = `tag tag-sector-${(c.sector||'consumer').toLowerCase()}`;
  const pedigreeHtml = (c.founderPedigree||[]).slice(0,3).map(p => `<span class="pedigree-tag">${p}</span>`).join('');
  const backedStr = (c.backedBy||[]).slice(0,2).join(', ');

  return `
  <div class="company-card" onclick="Modal.showCompanyDetail('${c.id}')" data-id="${c.id}">
    <div class="card-header">
      <div class="card-company-info">
        <div class="card-name">${c.name}</div>
        <div class="card-hq">${c.hq || c.geography} · ${backedStr || 'Untracked'}</div>
      </div>
      <div class="score-ring">
        ${scoreRingSVG(c.thesisScore)}
        <div class="score-ring-val">${c.thesisScore}</div>
      </div>
    </div>
    <div class="card-tags">
      <span class="${urgencyClass}">${c.urgency || 'Med'} Urgency</span>
      <span class="${sectorClass}">${c.sector}</span>
      <span class="tag tag-signal">${c.signalType}</span>
      <span class="tag tag-stage">${c.stage}</span>
    </div>
    <div class="card-desc">${c.description}</div>
    <div class="card-why-now"><strong>⚡ Why Now:</strong> ${c.whyNow}</div>
    <div class="card-pedigree">${pedigreeHtml}</div>
    <div class="card-footer">
      <button class="btn btn-primary btn-xs" onclick="event.stopPropagation();Outreach.openOutreachFor('${c.id}')">✉ Outreach</button>
      <select class="filter-select" style="font-size:11px;padding:4px 22px 4px 8px;" onclick="event.stopPropagation()"
        onchange="event.stopPropagation();CRM.updateStatus('${c.id}',this.value);this.blur();">
        ${CONFIG.pipeline_stages.map(s=>`<option value="${s}" ${c.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 14. VIEW RENDERERS
// ══════════════════════════════════════════════════════════════════

// ─── DASHBOARD ────────────────────────────────────────────────────
function renderDashboard() {
  document.getElementById('page-title').textContent = 'Dashboard';
  document.getElementById('page-subtitle').textContent = 'Signal-to-Conviction Pipeline';

  const companies = State.getCompanies();
  const high = companies.filter(c => c.urgency === 'High' && c.status !== 'Pass');
  const inPipeline = companies.filter(c => !['New Signal','Pass'].includes(c.status));
  const passed = companies.filter(c => c.status === 'Pass');
  const active = companies.filter(c => c.status !== 'Pass');

  // Sector breakdown
  const sectors = { Fintech:0, B2B:0, AI:0, Consumer:0 };
  active.forEach(c => { if (sectors[c.sector] !== undefined) sectors[c.sector]++; });
  const maxSector = Math.max(...Object.values(sectors), 1);
  const sectorColors = { Fintech:'var(--sector-fintech)', B2B:'var(--sector-b2b)', AI:'var(--sector-ai)', Consumer:'var(--sector-consumer)' };

  // Top opportunities
  const topOpps = [...active].filter(c=>c.status !== 'Pass').sort((a,b) => b.thesisScore - a.thesisScore).slice(0,6);

  // Recent activity — derived from real tracker data (company add dates + the
  // last real scan), never fabricated. If nothing real has happened yet, say so.
  function daysAgoLabel(dateStr) {
    const then = new Date(dateStr);
    if (isNaN(then.getTime())) return '';
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  }

  const activityEvents = [];
  if (typeof LAST_SCAN !== 'undefined' && LAST_SCAN && LAST_SCAN.timestamp) {
    const ts = new Date(LAST_SCAN.timestamp).getTime();
    activityEvents.push({
      title: `Scan completed — ${LAST_SCAN.newCompanies ?? 0} new compan${LAST_SCAN.newCompanies === 1 ? 'y' : 'ies'} added`,
      time: daysAgoLabel(LAST_SCAN.timestamp),
      color: 'var(--gold)',
      sortKey: ts,
    });
  }
  [...companies]
    .filter(c => c.createdAt || c.addedDate)
    .forEach(c => {
      const dateStr = c.createdAt || c.addedDate;
      activityEvents.push({
        title: `<strong>${c.name}</strong> added — ${c.signalType || 'signal'}`,
        time: daysAgoLabel(dateStr),
        color: sectorColors[c.sector] || 'var(--text-muted)',
        sortKey: new Date(dateStr).getTime() || 0,
      });
    });

  const recentActivity = activityEvents.length
    ? activityEvents.sort((a, b) => b.sortKey - a.sortKey).slice(0, 6)
    : [{ title: 'No activity yet — run a scan or add a company', time: '', color: 'var(--text-muted)' }];

  const activityHtml = recentActivity.map(a => `
    <div class="activity-item">
      <div class="activity-dot" style="background:${a.color}"></div>
      <div class="activity-content">
        <div class="activity-title">${a.title}</div>
        <div class="activity-time">${a.time}</div>
      </div>
    </div>`).join('');

  const sectorBarsHtml = Object.entries(sectors).map(([name, count]) => `
    <div class="sector-row">
      <div class="sector-name">${name}</div>
      <div class="sector-track">
        <div class="sector-fill" style="width:${Math.round(count/maxSector*100)}%;background:${sectorColors[name]}"></div>
      </div>
      <div class="sector-count">${count}</div>
    </div>`).join('');

  const topOppsHtml = topOpps.map((c, i) => `
    <div class="top-opp-item" onclick="Modal.showCompanyDetail('${c.id}')">
      <div class="top-opp-rank">${i+1}</div>
      <div class="top-opp-info">
        <div class="top-opp-name">${c.name}</div>
        <div class="top-opp-meta">${c.sector} · ${c.signalType} · ${c.urgency} Urgency</div>
      </div>
      <div class="top-opp-score">${c.thesisScore}</div>
    </div>`).join('');

  // Urgency breakdown
  const urgCounts = { High: companies.filter(c=>c.urgency==='High'&&c.status!=='Pass').length,
                       Medium: companies.filter(c=>c.urgency==='Medium'&&c.status!=='Pass').length,
                       Low: companies.filter(c=>c.urgency==='Low'&&c.status!=='Pass').length };
  const urgTotal = Math.max(urgCounts.High + urgCounts.Medium + urgCounts.Low, 1);

  const avgScore = active.length ? Math.round(active.reduce((a,c)=>a+c.thesisScore,0)/active.length) : 0;
  const depCount = (typeof SEED_DEPARTURES !== 'undefined' && Array.isArray(SEED_DEPARTURES)) ? SEED_DEPARTURES.length : 0;
  const buildingOwn = (typeof SEED_DEPARTURES !== 'undefined' && Array.isArray(SEED_DEPARTURES))
    ? SEED_DEPARTURES.filter(d => (d.moveType || 'starting_own') === 'starting_own').length : 0;

  // Signal-to-Conviction funnel — the flow every signal travels. Counts come
  // straight from the live pipeline (the same data the CRM Pipeline view uses).
  const pipe = State.getPipelineData();
  const stageMeta = [
    { key: 'New Signal',      label: 'New Signals',     color: 'var(--gold)' },
    { key: 'Researching',     label: 'Researching',     color: 'var(--blue)' },
    { key: 'Outreach Sent',   label: 'Outreach Sent',   color: 'var(--sector-b2b)' },
    { key: 'In Conversation', label: 'In Conversation', color: 'var(--urgent-low)' },
  ];
  const stages = stageMeta.map(s => ({ ...s, count: (pipe[s.key] || []).length }));
  const passedCount = (pipe['Pass'] || []).length;
  const maxStage = Math.max(...stages.map(s => s.count), 1);

  // KPI ribbon — vital signs, terminal-style. Non-redundant with the funnel.
  const kpis = [
    { label: 'Total Signals',     value: companies.length, sub: `${active.length} active · ${passed.length} passed`, accent: 'var(--gold)' },
    { label: 'High Urgency',      value: high.length,       sub: 'reach out this week',                              accent: 'var(--urgent-high)' },
    { label: 'Avg Thesis Score',  value: avgScore,          sub: `${active.filter(c=>c.thesisScore>=80).length} high-fit (80+)`, accent: 'var(--urgent-low)' },
    { label: 'Founder Departures',value: depCount,          sub: `${buildingOwn} building own co.`,                  accent: 'var(--blue)', nav: 'departures' },
  ];
  const kpiHtml = kpis.map(k => `
    <div class="kpi-seg" style="--accent:${k.accent}" ${k.nav ? `role="button" tabindex="0" onclick="Router.navigate('${k.nav}')"` : ''}>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-figure">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');

  const funnelHtml = stages.map((s, i) => `
    <div class="funnel-stage" style="--stage:${s.color}" role="button" tabindex="0" onclick="Router.navigate('pipeline')" title="Open ${s.label} in the pipeline">
      <div class="funnel-count">${s.count}</div>
      <div class="funnel-name">${s.label}</div>
      <div class="funnel-bar"><span style="width:${Math.round(s.count / maxStage * 100)}%"></span></div>
    </div>
    ${i < stages.length - 1 ? '<div class="funnel-arrow" aria-hidden="true">→</div>' : ''}`).join('');

  const scoreColor = (n) => n >= 80 ? 'var(--urgent-low)' : n >= 65 ? 'var(--gold)' : 'var(--text-muted)';
  const urgDot = (u) => u === 'High' ? 'var(--urgent-high)' : u === 'Medium' ? 'var(--urgent-med)' : 'var(--urgent-low)';
  const topOppsHtml2 = topOpps.map((c, i) => `
    <div class="top-opp-item" onclick="Modal.showCompanyDetail('${c.id}')">
      <div class="top-opp-rank">${String(i+1).padStart(2,'0')}</div>
      <div class="top-opp-info">
        <div class="top-opp-name">${c.name} <span class="urg-dot" style="background:${urgDot(c.urgency)}" title="${c.urgency} urgency"></span></div>
        <div class="top-opp-meta"><span class="sec-dot" style="background:${sectorColors[c.sector]||'var(--text-muted)'}"></span>${c.sector} · ${c.signalType}</div>
      </div>
      <div class="top-opp-gauge">
        <div class="opp-score" style="color:${scoreColor(c.thesisScore)}">${c.thesisScore}</div>
        <div class="opp-bar"><span style="width:${c.thesisScore}%;background:${scoreColor(c.thesisScore)}"></span></div>
      </div>
    </div>`).join('');

  // Follow-ups needing attention (overdue / no-touch first).
  const fuCts = Followups.counts();
  const fuTop = Followups.list({}).filter(r => r.info.bucket <= 2).slice(0, 5);
  const fuHtml = fuTop.length ? fuTop.map(({ c, info }) => {
    const kind = fuBadgeKind(info);
    return `
    <div class="dash-fu-item" onclick="Router.navigate('followups')">
      <div class="dash-fu-info">
        <div class="dash-fu-name">${c.name}</div>
        <div class="dash-fu-meta">${c.owner ? c.owner + ' · ' : ''}${c.status || 'New Signal'}</div>
      </div>
      <span class="fu-badge ${kind}" style="font-size:10px;">${FU_BADGE[kind].label(info)}</span>
      <button class="btn btn-primary btn-xs" onclick="event.stopPropagation();FollowupUI.openTouch('${c.id}')">Log</button>
    </div>`;
  }).join('') : `<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">All live deals are on cadence ✅</div>`;

  document.getElementById('view-container').innerHTML = `
    <div class="kpi-ribbon">${kpiHtml}</div>

    <div class="dash-card funnel-card">
      <div class="section-title">
        <span class="section-title-dot"></span>Signal → Conviction Funnel
        <span class="funnel-legend">${passedCount} passed · ${stages[3].count} live conversation${stages[3].count===1?'':'s'}</span>
      </div>
      <div class="funnel">${funnelHtml}</div>
    </div>

    <div class="dash-grid">
      <div class="dash-card">
        <div class="section-title"><span class="section-title-dot"></span>Top Opportunities by Thesis Score</div>
        ${topOppsHtml2}
        <button class="btn btn-ghost btn-sm" style="margin-top:14px;" onclick="Router.navigate('signals')">View all ${active.length} signals →</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="dash-card">
          <div class="section-title" style="justify-content:space-between;">
            <span style="display:flex;align-items:center;gap:8px;"><span class="section-title-dot" style="background:var(--urgent-high);"></span>Needs a Touch</span>
            <span style="text-transform:none;letter-spacing:0;font-size:11px;color:var(--text-muted);">${fuCts.overdue} overdue · ${fuCts.noTouch} new</span>
          </div>
          ${fuHtml}
          <button class="btn btn-ghost btn-sm" style="margin-top:12px;" onclick="Router.navigate('followups')">Open Follow-ups →</button>
        </div>
        <div class="dash-card">
          <div class="section-title"><span class="section-title-dot"></span>Sector Mix</div>
          ${sectorBarsHtml}
        </div>
        <div class="dash-card">
          <div class="section-title"><span class="section-title-dot"></span>Urgency Split</div>
          <div class="urg-meter">
            ${['High','Medium','Low'].map(u => `<span class="urg-seg urg-${u.toLowerCase()}" style="width:${Math.round(urgCounts[u]/urgTotal*100)}%" title="${u}: ${urgCounts[u]}"></span>`).join('')}
          </div>
          <div class="urg-keys">
            ${['High','Medium','Low'].map(u => `<div class="urg-key"><span class="urg-key-dot urg-${u.toLowerCase()}"></span>${u}<b>${urgCounts[u]}</b></div>`).join('')}
          </div>
        </div>
        <div class="dash-card">
          <div class="section-title"><span class="section-title-dot"></span>Recent Activity</div>
          ${activityHtml}
        </div>
      </div>
    </div>

    <div class="quick-actions">
      <button class="qa-btn" onclick="Router.navigate('signals')"><span class="qa-ico" style="--c:var(--gold)">⚡</span>Signal Feed</button>
      <button class="qa-btn" onclick="Router.navigate('departures')"><span class="qa-ico" style="--c:var(--blue)">🚀</span>Founder Departures</button>
      <button class="qa-btn" onclick="Router.navigate('followups')"><span class="qa-ico" style="--c:var(--urgent-high)">⏰</span>Follow-ups</button>
      <button class="qa-btn" onclick="Router.navigate('pipeline')"><span class="qa-ico" style="--c:var(--sector-b2b)">🗂</span>Pipeline</button>
      <button class="qa-btn" onclick="Router.navigate('investors')"><span class="qa-ico" style="--c:var(--urgent-low)">👤</span>Angel Network</button>
      <button class="qa-btn" onclick="Export.toCSV()"><span class="qa-ico" style="--c:var(--text-muted)">↓</span>Export CSV</button>
    </div>`;
}

// ─── SIGNAL FEED ──────────────────────────────────────────────────
function renderSignals() {
  document.getElementById('page-title').textContent = 'Signal Feed';
  document.getElementById('page-subtitle').textContent = 'All sourced companies — filter and track';

  const filtered = CRM.getFilteredCompanies();

  const signalTypes = [...new Set(State.companies.map(c=>c.signalType))];

  document.getElementById('view-container').innerHTML = `
    <div class="filter-bar">
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="var(--text-muted)"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>
        <input id="search-input" type="text" placeholder="Search companies, sectors, founders..." value="${State.filters.search}"
          oninput="State.filters.search=this.value;renderSignals()">
      </div>
      <select class="filter-select" onchange="State.filters.sector=this.value;renderSignals()">
        <option value="all" ${State.filters.sector==='all'?'selected':''}>All Sectors</option>
        <option value="Fintech" ${State.filters.sector==='Fintech'?'selected':''}>Fintech</option>
        <option value="B2B" ${State.filters.sector==='B2B'?'selected':''}>B2B</option>
        <option value="AI" ${State.filters.sector==='AI'?'selected':''}>AI</option>
        <option value="Consumer" ${State.filters.sector==='Consumer'?'selected':''}>Consumer</option>
      </select>
      <select class="filter-select" onchange="State.filters.urgency=this.value;renderSignals()">
        <option value="all" ${State.filters.urgency==='all'?'selected':''}>All Urgency</option>
        <option value="High" ${State.filters.urgency==='High'?'selected':''}>🔴 High</option>
        <option value="Medium" ${State.filters.urgency==='Medium'?'selected':''}>🟡 Medium</option>
        <option value="Low" ${State.filters.urgency==='Low'?'selected':''}>🟢 Low</option>
      </select>
      <select class="filter-select" onchange="State.filters.stage=this.value;renderSignals()">
        <option value="all" ${State.filters.stage==='all'?'selected':''}>All Stages</option>
        <option value="Pre-Seed" ${State.filters.stage==='Pre-Seed'?'selected':''}>Pre-Seed</option>
        <option value="Seed" ${State.filters.stage==='Seed'?'selected':''}>Seed</option>
        <option value="Series A" ${State.filters.stage==='Series A'?'selected':''}>Series A</option>
      </select>
      <select class="filter-select" onchange="State.filters.signalType=this.value;renderSignals()">
        <option value="all">All Signal Types</option>
        ${signalTypes.map(st=>`<option value="${st}" ${State.filters.signalType===st?'selected':''}>${st}</option>`).join('')}
      </select>
      <div style="margin-left:auto;font-size:12px;color:var(--text-muted);">${filtered.length} companies</div>
    </div>

    <div class="company-grid">
      ${filtered.length ? filtered.map(c => renderCompanyCard(c)).join('') : `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">🔍</div>
          <div class="empty-title">No companies match your filters</div>
          <div class="empty-sub">Try adjusting your search or filters</div>
          <button class="btn btn-ghost" style="margin-top:12px" onclick="State.filters={sector:'all',urgency:'all',stage:'all',search:'',signalType:'all'};renderSignals()">Clear Filters</button>
        </div>`}
    </div>`;

  document.getElementById('signal-count').textContent = State.companies.filter(c=>c.status==='New Signal').length;
}

// ─── FOUNDER DEPARTURES ───────────────────────────────────────────
// Signal 1: senior leadership departures at large companies — either building
// their own company (strong, actionable) or stepped down / resigned (early
// watch signal). Populated by the Firecrawl crawl → data/departures.json.
// Manually-logged founders (captured from the LinkedIn sweep) live in
// localStorage and are merged on top of the crawled SEED_DEPARTURES — same
// layering pattern the CRM uses for company edits. No backend write needed.
const UserDepartures = {
  KEY: 'sparrow_departures_manual',
  all() {
    try { const v = JSON.parse(localStorage.getItem(this.KEY)); return Array.isArray(v) ? v : []; }
    catch { return []; }
  },
  save(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); },
  add(rec) { const list = this.all(); list.unshift(rec); this.save(list); },
  remove(id) { this.save(this.all().filter(d => d.id !== id)); },
};

function getDepartures() {
  const seed = (typeof SEED_DEPARTURES !== 'undefined' && Array.isArray(SEED_DEPARTURES)) ? SEED_DEPARTURES : [];
  return [...UserDepartures.all(), ...seed];
}

// Move-type presentation. Records from before this feature default to
// starting_own (the old crawler only ever captured that).
const MOVE_META = {
  starting_own: { label: 'Building own co.', cls: 'move-own', line: 'Now building', icon: '🚀' },
  stepped_down: { label: 'Stepped down', cls: 'move-step', line: 'Next move', icon: '👀' },
};
function moveOf(d) { return MOVE_META[d.moveType] ? d.moveType : 'starting_own'; }

function departureCard(d) {
  const mt = moveOf(d);
  const meta = MOVE_META[mt];
  const sectorClass = `tag tag-sector-${(d.sector||'consumer').toLowerCase().replace(/[^a-z]/g,'')}`;
  const initials = (d.founder||'?').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const li = d.linkedin
    ? `<a class="btn btn-ghost btn-xs" href="${d.linkedin}" target="_blank" rel="noopener" onclick="event.stopPropagation()">in · LinkedIn</a>`
    : `<span class="tag" style="opacity:.5">LinkedIn n/a</span>`;
  const src = d.source ? `<a href="${d.source}" target="_blank" rel="noopener" style="color:var(--text-muted);font-size:11px;">source ↗</a>` : '';
  const watch = d.watchlisted ? `<span class="tag move-watch" title="Alumni of a founder-factory watchlist company">★ Watchlist</span>` : '';
  const manual = d.manual ? `<span class="tag" style="background:rgba(59,130,246,.12);color:var(--blue);font-weight:600;" title="Logged manually">✎ Logged</span>` : '';
  const remove = d.manual ? `<button class="dep-remove" title="Remove" onclick="event.stopPropagation();LinkedInCapture.removeConfirm('${d.id}','${(d.founder||'').replace(/'/g,"\\'")}')">✕</button>` : '';
  const desc = mt === 'starting_own'
    ? `<strong>${meta.line}:</strong> ${d.currentBuilding||'New venture (details emerging)'}`
    : `<strong>${meta.line}:</strong> not announced yet — watch for their next company`;
  return `
  <div class="company-card dep-card ${meta.cls}">
    <div class="card-header">
      <div class="card-company-info" style="display:flex;gap:12px;align-items:center;">
        <div class="dep-avatar">${initials}</div>
        <div>
          <div class="card-name">${d.founder}</div>
          <div class="card-hq">${d.exDesignation||'Senior'} · ex-<strong>${d.exEmployer}</strong></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="tag move-badge ${meta.cls}">${meta.icon} ${meta.label}</span>
        ${remove}
      </div>
    </div>
    <div class="card-tags">
      ${d.sector && !/^unspecified$/i.test(d.sector) ? `<span class="${sectorClass}">${d.sector}</span>` : ''}
      ${watch}
      ${manual}
    </div>
    <div class="card-desc">${desc}</div>
    <div class="card-footer" style="justify-content:space-between;">
      ${li}
      ${src}
    </div>
  </div>`;
}

function renderDepartures() {
  document.getElementById('page-title').textContent = 'Founder Departures';
  document.getElementById('page-subtitle').textContent = 'Senior leadership departures — building their own company, or stepped down (early watch)';

  const all = getDepartures();
  // Sort strongest signal first: building-own before stepped-down, watchlisted
  // alumni before the rest, newest before older.
  const rank = (d) => (moveOf(d) === 'starting_own' ? 0 : 1) * 10 + (d.watchlisted ? 0 : 1);
  const sorted = [...all].sort((a,b) => rank(a) - rank(b) || String(b.foundAt||'').localeCompare(String(a.foundAt||'')));

  const exEmployers = ['All', ...[...new Set(all.map(d => d.exEmployer).filter(Boolean))].sort()];
  const fx = State.filters.departureEx || 'All';
  const ft = State.filters.departureType || 'all';

  const byType = sorted.filter(d => ft === 'all' || moveOf(d) === ft);
  const filtered = fx === 'All' ? byType : byType.filter(d => d.exEmployer === fx);

  const nOwn = all.filter(d => moveOf(d) === 'starting_own').length;
  const nStep = all.length - nOwn;

  document.getElementById('view-container').innerHTML = `
    <div class="filter-bar" style="flex-wrap:wrap;gap:12px;">
      <div style="font-size:13px;color:var(--text-muted);max-width:560px;line-height:1.5;">
        Senior leaders leaving large companies — <strong>${nOwn}</strong> building their own company,
        <strong>${nStep}</strong> stepped down (watch for their next move). ★ = founder-factory alumni.
      </div>
      <div style="display:flex;gap:10px;margin-left:auto;flex-wrap:wrap;">
        <select class="filter-select" onchange="State.filters.departureType=this.value;renderDepartures()">
          <option value="all" ${ft==='all'?'selected':''}>All moves</option>
          <option value="starting_own" ${ft==='starting_own'?'selected':''}>🚀 Building own co.</option>
          <option value="stepped_down" ${ft==='stepped_down'?'selected':''}>👀 Stepped down</option>
        </select>
        <select class="filter-select" onchange="State.filters.departureEx=this.value;renderDepartures()">
          ${exEmployers.map(x=>`<option value="${x}" ${fx===x?'selected':''}>${x==='All'?'All ex-employers':'ex-'+x}</option>`).join('')}
        </select>
        <div style="font-size:12px;color:var(--text-muted);align-self:center;">${filtered.length} people</div>
      </div>
    </div>
    <div class="company-grid">
      ${filtered.length ? filtered.map(departureCard).join('') : `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">🕵️</div>
          <div class="empty-title">No leadership departures match this filter</div>
          <div class="empty-sub">Click <strong>Crawl Web</strong> (top right) to sweep Indian startup press for senior people stepping down or leaving to build their own company.</div>
        </div>`}
    </div>`;

  const badge = document.getElementById('departure-count');
  if (badge) badge.textContent = all.length;
}

// ─── LINKEDIN SEARCH BOARD ────────────────────────────────────────
// 15 founder factories × 4 status logics = 60 pre-built LinkedIn people
// searches. URLs are generated from the same faceted-search template the user
// supplied (same currentCompany facet across all), so they stay in sync.
const LI_COMPANIES = ['Razorpay','Flipkart','CRED','Swiggy','Meesho','PhonePe','Freshworks','Zerodha','Zomato','Blinkit','Cashfree','Open Money','Pine Labs','Juspay','PayU'];
const LI_STATUSES = [
  { key:'Founder',         icon:'🚀', color:'var(--gold)',       blurb:'Already founded' },
  { key:'Building',        icon:'🔨', color:'var(--blue)',       blurb:'Building something new' },
  { key:'Stealth Founder', icon:'🕵️', color:'var(--sector-b2b)', blurb:'In stealth' },
  { key:'Exploring',       icon:'🧭', color:'var(--urgent-med)', blurb:'Exploring / open to ideas' },
];
// The currentCompany facet, URL-encoded exactly as supplied — kept identical
// across every search so the generated links match the source set.
const LI_CURRENT_COMPANY = '%5B%2218583501%22%2C%2279372457%22%2C%2296670793%22%5D';
function liSearchUrl(company, status) {
  const kw = encodeURIComponent(`Ex-${company} , ${status}`);
  return `https://www.linkedin.com/search/results/people/?keywords=${kw}&origin=FACETED_SEARCH&currentCompany=${LI_CURRENT_COMPANY}`;
}

// Quick-capture: log a founder found in a LinkedIn search into Founder
// Departures in one step. Persists via UserDepartures (localStorage).
const LinkedInCapture = {
  openForm(prefillCompany) {
    const co = prefillCompany || '';
    const opts = LI_COMPANIES.map(c => `<option value="${c}" ${c===co?'selected':''}>${c}</option>`).join('');
    Modal.open(`
      <div class="modal-company-name" style="margin-bottom:4px;">Log a founder</div>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:16px;">Found someone building in a LinkedIn search? Capture them here — it's added to <strong>Founder Departures</strong> instantly.</p>
      <div class="cap-form">
        <label class="cap-field"><span>Founder name *</span><input id="cap-founder" type="text" placeholder="e.g. Aditi Rao" autocomplete="off"></label>
        <div class="cap-row">
          <label class="cap-field"><span>Ex-employer *</span><input id="cap-ex" list="cap-ex-list" value="${co}" placeholder="e.g. Razorpay" autocomplete="off">
            <datalist id="cap-ex-list">${opts}</datalist></label>
          <label class="cap-field"><span>Last designation there</span><input id="cap-desg" type="text" placeholder="e.g. VP Engineering" autocomplete="off"></label>
        </div>
        <label class="cap-field"><span>Move type</span>
          <select id="cap-move" class="filter-select" style="width:100%;">
            <option value="starting_own">🚀 Building own company</option>
            <option value="stepped_down">👀 Stepped down (watch)</option>
          </select></label>
        <div class="cap-row">
          <label class="cap-field"><span>Now building</span><input id="cap-build" type="text" placeholder="Venture name or 'stealth fintech'" autocomplete="off"></label>
          <label class="cap-field"><span>Sector</span><input id="cap-sector" type="text" placeholder="e.g. Fintech" autocomplete="off"></label>
        </div>
        <label class="cap-field"><span>LinkedIn URL</span><input id="cap-linkedin" type="text" placeholder="https://linkedin.com/in/…" autocomplete="off"></label>
        <div style="display:flex;gap:10px;margin-top:6px;">
          <button class="btn btn-primary" onclick="LinkedInCapture.save()">＋ Add to Founder Departures</button>
          <button class="btn btn-ghost" onclick="Modal.close({target:document.getElementById('modal-overlay')})">Cancel</button>
        </div>
      </div>`);
    setTimeout(() => { const f = document.getElementById('cap-founder'); if (f) f.focus(); }, 50);
  },

  save() {
    const val = id => (document.getElementById(id)?.value || '').trim();
    const founder = val('cap-founder');
    const ex = val('cap-ex');
    if (!founder || !ex) { Toast.show('Founder name and ex-employer are required.', 'error'); return; }
    const moveType = val('cap-move') === 'stepped_down' ? 'stepped_down' : 'starting_own';
    const factory = LI_COMPANIES.find(c => c.toLowerCase() === ex.toLowerCase());
    let linkedin = val('cap-linkedin');
    if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = 'https://' + linkedin;
    const rec = {
      id: 'u' + Date.now(),
      founder,
      exEmployer: factory || ex,
      exDesignation: val('cap-desg') || 'Senior (unspecified)',
      moveType,
      currentBuilding: moveType === 'starting_own' ? (val('cap-build') || 'New venture (details emerging)') : '',
      sector: val('cap-sector') || 'Unspecified',
      linkedin,
      watchlisted: !!factory,
      source: linkedin || '',
      status: 'New Signal',
      manual: true,
      foundAt: new Date().toISOString(),
    };
    UserDepartures.add(rec);
    Modal.close({ target: document.getElementById('modal-overlay') });
    Toast.show(`${founder} added to Founder Departures`, 'success');
    const badge = document.getElementById('departure-count');
    if (badge) badge.textContent = getDepartures().length;
    if (State.currentView === 'departures') renderDepartures();
  },

  removeConfirm(id, name) {
    if (confirm(`Remove ${name} from Founder Departures?`)) {
      UserDepartures.remove(id);
      Toast.show(`${name} removed`, 'info');
      renderDepartures();
    }
  },
};

function renderLinkedIn() {
  document.getElementById('page-title').textContent = 'LinkedIn';
  document.getElementById('page-subtitle').textContent = 'Founder-factory alumni × status — one-click boolean people searches';

  const co = State.filters.liCompany || 'all';
  const st = State.filters.liStatus || 'all';
  const companies = co === 'all' ? LI_COMPANIES : LI_COMPANIES.filter(c => c === co);
  const statuses  = st === 'all' ? LI_STATUSES  : LI_STATUSES.filter(s => s.key === st);
  const combos = companies.length * statuses.length;

  const cards = companies.map(c => `
    <div class="li-card">
      <div class="li-card-head"><span class="li-ex">Ex-</span>${c}</div>
      <div class="li-links">
        ${statuses.map(s => `
          <a class="li-link" style="--c:${s.color}" href="${liSearchUrl(c, s.key)}" target="_blank" rel="noopener" title="Open LinkedIn search: Ex-${c} · ${s.key} (${s.blurb})">
            <span class="li-ico">${s.icon}</span>
            <span class="li-status">${s.key}</span>
            <span class="li-open">↗</span>
          </a>`).join('')}
      </div>
    </div>`).join('');

  document.getElementById('view-container').innerHTML = `
    <div class="li-note">
      <strong>Sourcing sweep.</strong> Each link opens a LinkedIn people search for alumni of a founder factory whose headline signals a new venture. LinkedIn results are login-gated and can't be auto-scraped, so open a search, scan the profiles, and add anyone building to
      <a onclick="Router.navigate('departures')" style="color:var(--gold);cursor:pointer;font-weight:600;">Founder Departures</a> — noting their <strong>last designation at the last company</strong> as you go.
    </div>
    <div class="filter-bar" style="flex-wrap:wrap;gap:10px;">
      <button class="btn btn-primary btn-sm" onclick="LinkedInCapture.openForm(State.filters.liCompany!=='all'?State.filters.liCompany:'')">＋ Log a founder</button>
      <select class="filter-select" onchange="State.filters.liCompany=this.value;renderLinkedIn()">
        <option value="all" ${co==='all'?'selected':''}>All companies</option>
        ${LI_COMPANIES.map(c=>`<option value="${c}" ${co===c?'selected':''}>Ex-${c}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="State.filters.liStatus=this.value;renderLinkedIn()">
        <option value="all" ${st==='all'?'selected':''}>All statuses</option>
        ${LI_STATUSES.map(s=>`<option value="${s.key}" ${st===s.key?'selected':''}>${s.icon} ${s.key}</option>`).join('')}
      </select>
      <div style="margin-left:auto;font-size:12px;color:var(--text-muted);">${combos} search${combos===1?'':'es'}</div>
    </div>
    <div class="li-grid">${cards}</div>`;

  const badge = document.getElementById('linkedin-count');
  if (badge) badge.textContent = LI_COMPANIES.length * LI_STATUSES.length;
}

// ─── FOLLOW-UPS ───────────────────────────────────────────────────
const FU_BADGE = {
  overdue:  { cls: 'overdue',  label: (i) => `Overdue ${-i.delta}d` },
  notouch:  { cls: 'notouch',  label: () => 'No touch yet' },
  due:      { cls: 'due',      label: (i) => i.delta === 0 ? 'Due today' : `Due ${_relDays(i.delta)}` },
  upcoming: { cls: 'upcoming', label: (i) => `Due ${_relDays(i.delta)}` },
};
function fuBadgeKind(info) { return info.neverTouched ? 'notouch' : info.state; }

function followupRow(c, info) {
  const kind = fuBadgeKind(info);
  const b = FU_BADGE[kind];
  const sectorClass = `tag tag-sector-${(c.sector||'consumer').toLowerCase().replace(/[^a-z]/g,'')}`;
  const ownerChip = c.owner
    ? `<button class="fu-owner" onclick="event.stopPropagation();FollowupUI.assignOwner('${c.id}')" title="Reassign owner">👤 ${c.owner}</button>`
    : `<button class="fu-owner unassigned" onclick="event.stopPropagation();FollowupUI.assignOwner('${c.id}')" title="Assign an owner">+ Assign</button>`;
  const lastTouch = info.last ? `Last touch ${_relDays(_daysFromToday(info.last))}` : 'Never contacted';
  const next = c.nextAction ? `<div class="fu-next"><strong>Next:</strong> ${c.nextAction}</div>` : '';
  return `
  <div class="fu-row fu-${b.cls}" onclick="Modal.showCompanyDetail('${c.id}')">
    <div class="fu-main">
      <div class="fu-line1">
        <span class="fu-name">${c.name}</span>
        <span class="${sectorClass}" style="font-size:10px;">${c.sector}</span>
        <span class="tag tag-stage" style="font-size:10px;">${c.status || 'New Signal'}</span>
        ${c.urgency === 'High' ? '<span class="tag tag-urgency-high" style="font-size:10px;">High</span>' : ''}
      </div>
      <div class="fu-line2">${ownerChip}<span class="fu-lasttouch">${lastTouch}</span></div>
      ${next}
    </div>
    <div class="fu-right">
      <span class="fu-badge ${b.cls}">${b.label(info)}</span>
      <div class="fu-actions">
        <button class="btn btn-primary btn-xs" onclick="event.stopPropagation();FollowupUI.openTouch('${c.id}')">✓ Log touch</button>
        <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();Outreach.openOutreachFor('${c.id}')">✉ Draft</button>
      </div>
    </div>
  </div>`;
}

function renderFollowups() {
  document.getElementById('page-title').textContent = 'Follow-ups';
  const cts = Followups.counts();
  document.getElementById('page-subtitle').textContent =
    `${cts.needsAttention} deal${cts.needsAttention===1?'':'s'} need a touch — chase the overdue first`;

  const owner = State.filters.fuOwner || 'all';
  const status = State.filters.fuStatus || 'all';
  const overdueOnly = !!State.filters.fuOverdue;
  const rows = Followups.list({ owner, status, overdueOnly });
  const owners = Followups.owners();

  document.getElementById('view-container').innerHTML = `
    <div class="fu-summary">
      <button class="fu-stat ${overdueOnly?'active':''}" onclick="State.filters.fuOverdue=${!overdueOnly};renderFollowups()">
        <div class="fu-stat-num overdue">${cts.overdue}</div><div class="fu-stat-lbl">Overdue</div>
      </button>
      <div class="fu-stat"><div class="fu-stat-num notouch">${cts.noTouch}</div><div class="fu-stat-lbl">No touch yet</div></div>
      <div class="fu-stat"><div class="fu-stat-num due">${cts.dueSoon}</div><div class="fu-stat-lbl">Due soon</div></div>
    </div>
    <div class="filter-bar" style="flex-wrap:wrap;gap:10px;">
      <select class="filter-select" onchange="State.filters.fuStatus=this.value;renderFollowups()">
        <option value="all" ${status==='all'?'selected':''}>All stages</option>
        ${['New Signal','Researching','Outreach Sent','In Conversation'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="State.filters.fuOwner=this.value;renderFollowups()">
        <option value="all" ${owner==='all'?'selected':''}>All owners</option>
        <option value="unassigned" ${owner==='unassigned'?'selected':''}>Unassigned</option>
        ${owners.map(o=>`<option value="${o}" ${owner===o?'selected':''}>${o}</option>`).join('')}
      </select>
      <button class="btn ${overdueOnly?'btn-primary':'btn-ghost'} btn-sm" onclick="State.filters.fuOverdue=${!overdueOnly};renderFollowups()">${overdueOnly?'✓ Overdue only':'Overdue only'}</button>
      <div style="margin-left:auto;font-size:12px;color:var(--text-muted);">${rows.length} shown</div>
    </div>
    <div class="fu-list">
      ${rows.length ? rows.map(r => followupRow(r.c, r.info)).join('') : `
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <div class="empty-title">Nothing owed a touch right now</div>
          <div class="empty-sub">Every live deal is on cadence. New signals will surface here as they age.</div>
        </div>`}
    </div>`;

  const badge = document.getElementById('followup-count');
  if (badge) badge.textContent = cts.needsAttention;
}

// Touch-logging modal.
const FollowupUI = {
  openTouch(id) {
    const c = State.companies.find(x => x.id === id); if (!c) return;
    const cad = Followups.cadence(c.status || 'New Signal') ?? 4;
    const nd = new Date(); nd.setDate(nd.getDate() + cad);
    const dueDefault = nd.toISOString().split('T')[0];
    const recent = (c.touches || []).slice(0, 3).map(t =>
      `<div class="fu-hist"><span>${new Date(t.at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})} · ${t.channel}</span>${t.note ? `<span class="fu-hist-note">${t.note}</span>` : ''}</div>`).join('');
    Modal.open(`
      <div class="modal-company-name" style="margin-bottom:4px;">Log a touch — ${c.name}</div>
      <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:16px;">Records the contact and resets the cadence (${c.status || 'New Signal'} → next due in ${cad} days).</p>
      <div class="cap-form">
        <label class="cap-field"><span>Channel</span>
          <select id="fu-channel" class="filter-select" style="width:100%;">
            ${TOUCH_CHANNELS.map(ch=>`<option value="${ch}">${ch}</option>`).join('')}
          </select></label>
        <label class="cap-field"><span>What happened</span>
          <textarea id="fu-note" rows="3" placeholder="e.g. Sent intro note via Kunal Shah; awaiting reply" style="resize:vertical;"></textarea></label>
        <div class="cap-row">
          <label class="cap-field"><span>Next action</span><input id="fu-action" type="text" value="${c.nextAction ? String(c.nextAction).replace(/"/g,'&quot;') : ''}" placeholder="e.g. Follow up if no reply"></label>
          <label class="cap-field"><span>Next due</span><input id="fu-due" type="date" value="${dueDefault}"></label>
        </div>
        ${recent ? `<div style="font-size:11px;color:var(--text-muted);"><div style="margin-bottom:4px;font-weight:600;">Recent touches</div>${recent}</div>` : ''}
        <div style="display:flex;gap:10px;margin-top:6px;">
          <button class="btn btn-primary" onclick="FollowupUI.saveTouch('${c.id}')">✓ Log touch</button>
          <button class="btn btn-ghost" onclick="Modal.close({target:document.getElementById('modal-overlay')})">Cancel</button>
        </div>
      </div>`);
  },

  saveTouch(id) {
    const val = i => (document.getElementById(i)?.value || '').trim();
    Followups.logTouch(id, val('fu-channel'), val('fu-note'), val('fu-action') || undefined);
    const due = val('fu-due');
    if (due) Followups.setNextAction(id, undefined, due);
    Modal.close({ target: document.getElementById('modal-overlay') });
    if (State.currentView === 'followups') renderFollowups();
    else if (State.currentView === 'dashboard') renderDashboard();
    const badge = document.getElementById('followup-count');
    if (badge) { badge.textContent = Followups.counts().needsAttention; }
  },

  assignOwner(id) {
    const c = State.companies.find(x => x.id === id); if (!c) return;
    const name = prompt(`Who owns ${c.name}? (internal owner)`, c.owner || '');
    if (name === null) return;
    Followups.setOwner(id, name);
    if (State.currentView === 'followups') renderFollowups();
  },
};

// ─── MEMOS & THE PLAYBOOK ─────────────────────────────────────────
// Distilled from 100x.vc's "Why We Invested" memos + the Alexander Jarvis
// collection of classic VC memos. This rubric is what the platform reasons
// with when it gives suggestions on a company (see memoLens()).
const MEMO_PLAYBOOK = [
  { n:1, title:'Founder–market fit', principle:'The best memos lead with why THIS founder — unfair insight, lived obsession, or domain scar tissue (Twilio\'s devs, Shopify\'s Lütke).', apply:'Reward founders with direct operating time in the exact problem; discount generic "smart team".' },
  { n:2, title:'Why now', principle:'A named catalyst — regulatory, platform, cost, or behavior shift — that makes this the moment (YouTube: cheap bandwidth + cameras; DoorDash: smartphones + suburban density).', apply:'Demand a specific "why now"; "big market" is not a catalyst.' },
  { n:3, title:'Narrow wedge, big adjacent', principle:'Start absurdly specific, expand later (DoorDash suburbs; Twilio one API; 100x pick a sharp ICP).', apply:'Look for a painfully specific first customer + a credible expansion path.' },
  { n:4, title:'Distribution edge', principle:'A cheap, compounding acquisition loop — developer-led, viral, or self-serve (Twilio, Snapchat, Wix).', apply:'Prefer organic pull and low-CAC loops over paid-only growth.' },
  { n:5, title:'Contrarian & right', principle:'The market is bigger or realer than consensus thinks (Pinterest, Shopify, Twitch were underestimated).', apply:'Flag when others call it "small/niche" but the wedge says otherwise.' },
  { n:6, title:'Traction quality > quantity', principle:'Retention, engagement, and love from a few beat vanity growth (Snapchat DAU/engagement).', apply:'Weight cohort retention, DAU/MAU, and waitlists over topline signups.' },
  { n:7, title:'Path to economics', principle:'A believable route to margin even pre-revenue (Shopify take-rate, Twilio usage-based, Dropcam recurring attach).', apply:'Ask for the monetization logic and unit-economics story.' },
  { n:8, title:'Compounding moat', principle:'Network effects, proprietary data, switching costs, or embedded workflow (LinkedIn graph, PagerDuty stickiness).', apply:'Look for something that gets harder to displace over time.' },
  { n:9, title:'India wedge (100x lens)', principle:'A real India pain, India-scale distribution, capital-efficient build, riding formalization / India-stack tailwinds.', apply:'For India seed, reward frugal builders solving a concrete India problem.' },
  { n:10, title:'Name the anti-thesis', principle:'Great memos state what could kill the deal and why they\'re comfortable anyway (FTX: pedigree ≠ governance).', apply:'Trust founders and memos that are clear-eyed about the top risk.' },
];

function getMemos() {
  return (typeof SEED_MEMOS !== 'undefined' && Array.isArray(SEED_MEMOS)) ? SEED_MEMOS : [];
}

// Memo-informed read on one company — turns the playbook into concrete
// suggestions using whatever we know about the company.
function memoLens(c) {
  const tips = [];
  const has = (v) => v && String(v).trim().length > 8;
  if (has(c.whyNow)) tips.push({ ok:true,  p:'Why now', t:`Catalyst is stated — pressure-test it: a real shift, or just "big market"? "${String(c.whyNow).slice(0,90)}…"` });
  else tips.push({ ok:false, p:'Why now', t:'No clear "why now" captured — ask the founder what changed that makes this the moment.' });
  if ((c.founderPedigree||[]).length) tips.push({ ok:true,  p:'Founder–market fit', t:`Pedigree present (${(c.founderPedigree||[]).slice(0,3).join(', ')}). Confirm it maps to THIS problem, not just a good logo.` });
  else tips.push({ ok:false, p:'Founder–market fit', t:'Founder–market fit not documented — the #1 thing memos lead with. Dig into why this founder for this problem.' });
  if ((c.geography||'').toLowerCase().includes('india')) tips.push({ ok:true, p:'India wedge', t:'India-based — check the wedge is a concrete India pain with a capital-efficient build (100x lens).' });
  if (['Pre-Seed','Seed'].includes(c.stage)) tips.push({ ok:true, p:'Traction quality', t:'Early stage — weight retention/engagement and a sharp first ICP over topline growth (wedge before scale).' });
  tips.push({ ok:null, p:'Anti-thesis', t:'Before the call, write the one thing most likely to kill this deal — and what would make you comfortable anyway.' });
  return tips.slice(0, 5);
}

function memoCard(m) {
  const secClass = `tag tag-sector-${(m.sector||'other').toLowerCase().replace(/[^a-z]/g,'')}`;
  const badge = m.source === '100x'
    ? `<span class="memo-src memo-100x">100x · India</span>`
    : `<span class="memo-src memo-classic">${m.fund||'Classic'}</span>`;
  return `
  <div class="memo-card">
    <div class="memo-head">
      <div class="memo-co">${m.company}</div>
      ${badge}
    </div>
    <div class="memo-tags">
      <span class="${secClass}" style="font-size:10px;">${m.sector||'Other'}</span>
      ${m.stage ? `<span class="tag tag-stage" style="font-size:10px;">${m.stage}</span>` : ''}
    </div>
    ${m.bet ? `<div class="memo-line"><span class="memo-k">Bet</span>${m.bet}</div>` : ''}
    ${m.insight ? `<div class="memo-line"><span class="memo-k">Insight</span>${m.insight}</div>` : ''}
    ${m.lesson ? `<div class="memo-line lesson"><span class="memo-k">Lesson</span>${m.lesson}</div>` : ''}
    ${m.signal ? `<div class="memo-signal">🎯 ${m.signal}</div>` : ''}
    ${m.url ? `<a class="memo-read" href="${m.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Read the memo ↗</a>` : ''}
  </div>`;
}

function renderMemos() {
  document.getElementById('page-title').textContent = 'Memos';
  const memos = getMemos();
  document.getElementById('page-subtitle').textContent =
    `${memos.length} investment memos analyzed — the playbook the model reasons with`;

  const src = State.filters.memoSource || 'all';
  const sec = State.filters.memoSector || 'all';
  const q = (State.filters.memoSearch || '').toLowerCase();
  const list = memos.filter(m =>
    (src === 'all' || m.source === src) &&
    (sec === 'all' || m.sector === sec) &&
    (!q || `${m.company} ${m.fund} ${m.sector} ${m.bet} ${m.lesson} ${m.signal}`.toLowerCase().includes(q)));
  const sectors = [...new Set(memos.map(m => m.sector).filter(Boolean))].sort();

  const playbookRows = MEMO_PLAYBOOK.map(p => `
    <tr>
      <td class="mt-n">${p.n}</td>
      <td class="mt-strong">${p.title}</td>
      <td>${p.principle}</td>
      <td class="mt-apply">${p.apply}</td>
    </tr>`).join('');

  const secCls = (s) => `tag tag-sector-${(s||'other').toLowerCase().replace(/[^a-z]/g,'')}`;
  const srcCell = (m) => m.source === '100x'
    ? `<span class="memo-src memo-100x">100x · India</span>`
    : `<span class="memo-src memo-classic">${m.fund||'Classic'}</span>`;
  const memoRows = list.map(m => `
    <tr>
      <td class="mt-co">${m.company}${m.url ? ` <a href="${m.url}" target="_blank" rel="noopener" title="Read the memo" style="color:var(--text-muted);font-weight:400;">↗</a>` : ''}</td>
      <td>${srcCell(m)}</td>
      <td>${m.sector ? `<span class="${secCls(m.sector)}" style="font-size:10px;">${m.sector}</span>` : '—'}</td>
      <td class="mt-nowrap">${m.stage || '—'}</td>
      <td>${m.bet || '—'}</td>
      <td>${m.insight || '—'}</td>
      <td class="mt-strong">${m.lesson || '—'}</td>
      <td class="mt-signal">${m.signal || '—'}</td>
    </tr>`).join('');

  document.getElementById('view-container').innerHTML = `
    <div class="dash-card" style="margin-bottom:20px;">
      <div class="section-title"><span class="section-title-dot"></span>The Sparrow Memo Playbook — synthesized from ${memos.length} memos</div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:16px;line-height:1.6;max-width:760px;">
        The recurring patterns behind conviction across 100x.vc's India-seed memos and the classic VC memos (Sequoia/YouTube, Bessemer/Twilio &amp; Shopify, Benchmark, Lightspeed…). This rubric drives the <strong>memo-informed read</strong> shown on every company — open any signal to see it.
      </p>
      <div class="table-scroll">
        <table class="memo-table playbook-table">
          <thead><tr><th>#</th><th>Pattern</th><th>What great memos do</th><th>How to apply</th></tr></thead>
          <tbody>${playbookRows}</tbody>
        </table>
      </div>
    </div>

    <div class="filter-bar" style="flex-wrap:wrap;gap:10px;">
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="var(--text-muted)"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>
        <input type="text" placeholder="Search company, fund, lesson…" value="${State.filters.memoSearch||''}" oninput="State.filters.memoSearch=this.value;renderMemos()">
      </div>
      <select class="filter-select" onchange="State.filters.memoSource=this.value;renderMemos()">
        <option value="all" ${src==='all'?'selected':''}>All sources</option>
        <option value="100x" ${src==='100x'?'selected':''}>100x.vc (India seed)</option>
        <option value="jarvis" ${src==='jarvis'?'selected':''}>Classic VC memos</option>
      </select>
      <select class="filter-select" onchange="State.filters.memoSector=this.value;renderMemos()">
        <option value="all" ${sec==='all'?'selected':''}>All sectors</option>
        ${sectors.map(s=>`<option value="${s}" ${sec===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <div style="margin-left:auto;font-size:12px;color:var(--text-muted);">${list.length} memos</div>
    </div>
    ${list.length ? `
    <div class="table-scroll">
      <table class="memo-table library-table">
        <thead><tr>
          <th>Company</th><th>Source</th><th>Sector</th><th>Stage</th>
          <th>The bet</th><th>Insight</th><th>Lesson</th><th>Signal to look for</th>
        </tr></thead>
        <tbody>${memoRows}</tbody>
      </table>
    </div>` : `
      <div class="empty-state">
        <div class="empty-icon">📄</div>
        <div class="empty-title">No memos match your filters</div>
        <div class="empty-sub">Try a different source, sector, or search term.</div>
      </div>`}`;

  const badge = document.getElementById('memo-count');
  if (badge) badge.textContent = memos.length;
}

// ─── PIPELINE ─────────────────────────────────────────────────────
function renderPipeline() {
  document.getElementById('page-title').textContent = 'CRM Pipeline';
  document.getElementById('page-subtitle').textContent = 'Drag companies between stages · Click to view details';

  const pipeline = State.getPipelineData();
  const colColors = {
    'New Signal':       'var(--gold)',
    'Researching':      'var(--blue)',
    'Outreach Sent':    'var(--sector-b2b)',
    'In Conversation':  'var(--urgent-low)',
    'Pass':             'var(--text-muted)',
  };

  const columnsHtml = CONFIG.pipeline_stages.map(stageName => {
    const items = pipeline[stageName] || [];
    const cardsHtml = items.map(c => {
      const urgClass = `tag tag-urgency-${(c.urgency||'medium').toLowerCase()}`;
      const sectorClass = `tag tag-sector-${(c.sector||'consumer').toLowerCase()}`;
      return `
      <div class="kanban-item" draggable="true"
        ondragstart="State.draggedId='${c.id}';this.classList.add('dragging')"
        ondragend="this.classList.remove('dragging')"
        onclick="Modal.showCompanyDetail('${c.id}')">
        <div class="kanban-item-name">${c.name}</div>
        <div class="kanban-item-meta">
          <span class="${sectorClass}">${c.sector}</span>
          <span class="${urgClass}">${c.urgency||'Med'}</span>
          <span class="tag tag-stage" style="font-size:10px;">${c.thesisScore}</span>
        </div>
        ${c.notes ? `<div style="font-size:10.5px;color:var(--text-muted);margin-top:5px;line-height:1.4;">${c.notes.substring(0,60)}${c.notes.length>60?'...':''}</div>` : ''}
      </div>`;
    }).join('');

    return `
    <div class="kanban-col">
      <div class="kanban-col-header">
        <span class="kanban-col-name" style="color:${colColors[stageName]}">${stageName}</span>
        <span class="kanban-count">${items.length}</span>
      </div>
      <div class="kanban-cards" id="kanban-${stageName.replace(/\s+/g,'-')}"
        ondragover="event.preventDefault();this.classList.add('drag-over')"
        ondragleave="this.classList.remove('drag-over')"
        ondrop="event.preventDefault();this.classList.remove('drag-over');
          if(State.draggedId){CRM.updateStatus(State.draggedId,'${stageName}');State.draggedId=null;renderPipeline();}">
        ${cardsHtml}
        ${items.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:11px;">Drop here</div>' : ''}
      </div>
    </div>`;
  }).join('');

  document.getElementById('view-container').innerHTML = `
    <div class="kanban-board">${columnsHtml}</div>`;
}

// ─── INVESTORS ────────────────────────────────────────────────────
// Recent investments in the last 12 months, newest first. Reads the crawled
// `recent12mo` field (populated by the investor research/crawl) and keeps only
// entries dated within ~12 months of today, so the label never overstates.
function recent12mo(inv) {
  const list = Array.isArray(inv.recent12mo) ? inv.recent12mo : [];
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 13);
  const parse = (d) => {
    if (!d) return 0;
    const m = String(d).match(/(\d{4})(?:-(\d{1,2}))?/);
    return m ? new Date(+m[1], (m[2] ? +m[2] : 6) - 1, 1).getTime() : 0;
  };
  return list
    .filter(r => r && r.company)
    .filter(r => { const t = parse(r.date); return !t || t >= cutoff.getTime(); })
    .sort((a,b) => parse(b.date) - parse(a.date));
}
function fmtInvDate(d) {
  if (!d) return 'recent';
  const m = String(d).match(/(\d{4})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2]-1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const y = String(d).match(/\d{4}/);
  return y ? y[0] : d;
}

function renderInvestors() {
  document.getElementById('page-title').textContent = 'Angel Network';

  const sectorFilter = State.filters.investorSector || 'all';

  const filtered = sectorFilter === 'all' ? State.investors :
    State.investors.filter(i => i.thesis.includes(sectorFilter));

  const withRecent = filtered.filter(i => recent12mo(i).length).length;
  document.getElementById('page-subtitle').textContent =
    `${State.investors.length} tracked investors · ${withRecent} with fresh deals in the last 12 months`;

  const cardsHtml = filtered.map(inv => {
    const thesisTags = inv.thesis.map(t => {
      const cls = {Fintech:'tag-sector-fintech',B2B:'tag-sector-b2b',AI:'tag-sector-ai',Consumer:'tag-sector-consumer'}[t] || 'tag-signal';
      return `<span class="tag ${cls}" style="font-size:10px;">${t}</span>`;
    }).join('');

    const r12 = recent12mo(inv);
    let recentBlock;
    if (r12.length) {
      const names = r12.slice(0,3).map(r=>r.company).join(', ');
      const more = r12.length > 3 ? ` +${r12.length-3}` : '';
      recentBlock = `<div class="investor-recent fresh"><span class="recent-label">Last 12 mo</span> <span>${names}${more}</span></div>`;
    } else {
      const known = (inv.recentInvestments || []).slice(0,3).map(r=>r.company).join(', ');
      recentBlock = known
        ? `<div class="investor-recent"><span class="recent-label muted">Portfolio</span> <span>${known}</span></div>`
        : '';
    }

    return `
    <div class="investor-card" onclick="Modal.open(investorDetailHTML('${inv.id}'))">
      <div class="investor-header">
        <div class="investor-avatar">${inv.emoji}</div>
        <div>
          <div class="investor-name">${inv.name}</div>
          <div class="investor-role">${inv.role}</div>
        </div>
      </div>
      <div class="investor-sectors">${thesisTags}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Ticket: <span style="color:var(--gold)">${inv.avgTicket}</span></div>
      ${recentBlock}
      ${inv.twitter ? `<div style="font-size:10.5px;color:var(--text-muted);margin-top:6px;">${inv.twitter}</div>` : ''}
    </div>`;
  }).join('');

  document.getElementById('view-container').innerHTML = `
    <div class="filter-bar" style="margin-bottom:20px;">
      <select class="filter-select" onchange="State.filters.investorSector=this.value;renderInvestors()">
        <option value="all">All Sectors</option>
        <option value="Fintech">Fintech</option>
        <option value="Consumer">Consumer</option>
        <option value="B2B">B2B</option>
        <option value="AI">AI</option>
      </select>
      <div style="margin-left:auto;font-size:12px;color:var(--text-muted);">${filtered.length} investors</div>
    </div>
    <div class="investor-grid">${cardsHtml}</div>`;
}

// Investor detail modal HTML
function investorDetailHTML(invId) {
  const inv = State.investors.find(i => i.id === invId);
  if (!inv) return '<div>Investor not found</div>';

  const note = inv.note || inv.notes || 'Warm intro via a shared portfolio founder is the strongest path.';
  const r12 = recent12mo(inv);
  const recentHtml = r12.map(r =>
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);">
      <div style="min-width:0;">
        <div style="font-size:13px;font-weight:600;">${r.company}${r.source ? ` <a href="${r.source}" target="_blank" rel="noopener" style="color:var(--text-muted);font-size:10px;font-weight:400;">↗</a>` : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);">${r.sector || '—'}</div>
      </div>
      <div style="font-size:11px;color:var(--gold);font-family:'JetBrains Mono',monospace;white-space:nowrap;">${fmtInvDate(r.date)}</div>
    </div>`).join('');

  const portfolioHtml = (inv.portfolio||[]).map(p => `<span class="portfolio-tag">${p}</span>`).join('');

  return `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
      <div class="investor-avatar" style="width:54px;height:54px;font-size:26px;">${inv.emoji}</div>
      <div>
        <div style="font-size:22px;font-weight:800;">${inv.name}</div>
        <div style="font-size:13px;color:var(--text-muted);">${inv.role}</div>
      </div>
    </div>
    <div style="padding:14px;background:var(--gold-dim);border:1px solid rgba(245,158,11,0.2);border-radius:8px;margin-bottom:16px;font-size:12.5px;color:var(--text-secondary);line-height:1.6;">
      💡 ${note}
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Thesis & Ticket Size</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${inv.thesis.map(t=>`<span class="tag tag-sector-${t.toLowerCase()}" style="font-size:11px;">${t}</span>`).join('')}</div>
      <div style="font-size:13px;color:var(--text-secondary);">Avg Ticket: <span style="color:var(--gold);font-weight:600;">${inv.avgTicket}</span></div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Focus: ${inv.sectors}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Recent Investments · Last 12 Months</div>
      ${recentHtml || '<div style="color:var(--text-muted);font-size:12px;line-height:1.6;">No investments verified in the last 12 months — this investor has been quiet, or recent deals aren\'t publicly reported yet.</div>'}
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Known Portfolio</div>
      <div class="portfolio-companies">${portfolioHtml || '<span style="color:var(--text-muted);font-size:12px;">Data not available</span>'}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Contact Strategy</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${inv.linkedin ? `<a href="${inv.linkedin}" target="_blank" class="btn btn-secondary btn-sm">LinkedIn</a>` : ''}
        ${inv.twitter ? `<a href="${inv.twitter}" target="_blank" class="btn btn-ghost btn-sm">Twitter / X</a>` : ''}
        <button class="btn btn-primary btn-sm" onclick="Toast.show('Copy the \'useful thing\' data point: ${note.substring(0,30)}...','info')">💡 Get Intro Hook</button>
      </div>
    </div>`;
}

// ─── VC TRACKER ──────────────────────────────────────────────────
// Portfolio items may be plain strings (legacy) or enriched objects
// {name, provides, sector, stage, lastValuation, source}.
function pfName(p) { return typeof p === 'string' ? p : (p && p.name) || ''; }

function renderVCs() {
  document.getElementById('page-title').textContent = 'VC Tracker';
  document.getElementById('page-subtitle').textContent = '19 early-stage funds — portfolio & deal pipeline';

  const cardsHtml = State.vcs.map(vc => {
    const companiesHtml = (vc.recentPortfolio||[]).map(c=>
      `<span class="vc-company-tag">${pfName(c)}</span>`
    ).join('');

    const sectorTags = (vc.sectors||[]).map(s => {
      const cls = {Fintech:'tag-sector-fintech',B2B:'tag-sector-b2b',AI:'tag-sector-ai',Consumer:'tag-sector-consumer',All:'tag-signal',DeepTech:'tag-sector-ai',Sustainability:'tag-sector-consumer'}[s] || 'tag-signal';
      return `<span class="tag ${cls}" style="font-size:10px;">${s}</span>`;
    }).join('');

    return `
    <div class="vc-card" onclick="Modal.open(vcDetailHTML('${vc.id}'))">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div class="vc-name">${vc.name}</div>
        <span class="tag tag-stage" style="font-size:10px;">${vc.stage}</span>
      </div>
      <div class="vc-focus">${vc.focus}</div>
      <div class="vc-stats">
        <div class="vc-stat"><div class="vc-stat-val">${vc.portfolioCount}+</div><div class="vc-stat-label">Portfolio</div></div>
        <div class="vc-stat"><div class="vc-stat-val">${vc.vintage}</div><div class="vc-stat-label">Since</div></div>
        <div class="vc-stat"><div class="vc-stat-val" style="font-size:11px;">${vc.ticketSize}</div><div class="vc-stat-label">Ticket</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">${sectorTags}</div>
      <div class="vc-recent-companies">${companiesHtml}</div>
    </div>`;
  }).join('');

  document.getElementById('view-container').innerHTML = `
    <div style="margin-bottom:16px;font-size:12px;color:var(--text-muted);">
      ${State.vcs.length} funds tracked · Click any fund to view portfolio details and contact strategy
    </div>
    <div class="vc-grid">${cardsHtml}</div>`;
}

function vcDetailHTML(vcId) {
  const vc = State.vcs.find(v => v.id === vcId);
  if (!vc) return '<div>VC not found</div>';

  const secCls = (s) => `tag tag-sector-${(s||'other').toLowerCase().replace(/[^a-z]/g,'')}`;
  const isUndisclosed = (v) => !v || /^(undisclosed|n\/?a|unknown|-|—)?$/i.test(String(v).trim());
  const portfolioHtml = (vc.recentPortfolio||[]).map(c => {
    if (typeof c === 'string') return `<div class="pf-item"><div class="pf-name">${c}</div></div>`;
    const val = isUndisclosed(c.lastValuation) ? '' : `<span class="pf-val" title="Last known valuation">${c.lastValuation}</span>`;
    return `
    <div class="pf-item">
      <div class="pf-top">
        <span class="pf-name">${c.name}${c.source ? ` <a href="${c.source}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:10px;color:var(--text-muted);font-weight:400;">↗</a>` : ''}</span>
        <div class="pf-meta">
          ${c.sector ? `<span class="${secCls(c.sector)}" style="font-size:10px;">${c.sector}</span>` : ''}
          ${c.stage ? `<span class="tag tag-stage" style="font-size:10px;">${c.stage}</span>` : ''}
          ${val}
        </div>
      </div>
      ${c.provides ? `<div class="pf-provides">${c.provides}</div>` : ''}
    </div>`;
  }).join('');
  const sectorTags = (vc.sectors||[]).map(s => {
    const cls = {Fintech:'tag-sector-fintech',B2B:'tag-sector-b2b',AI:'tag-sector-ai',Consumer:'tag-sector-consumer',All:'tag-signal'}[s] || 'tag-signal';
    return `<span class="tag ${cls}" style="font-size:11px;">${s}</span>`;
  }).join('');

  // Find any companies in Sparrow pipeline backed by this VC
  const backedInPipeline = State.companies.filter(c =>
    (c.backedBy||[]).some(b => b.toLowerCase().includes(vc.name.toLowerCase()))
  );

  return `
    <div style="margin-bottom:16px;">
      <div style="font-size:22px;font-weight:800;margin-bottom:4px;">${vc.fullName}</div>
      <div style="font-size:13px;color:var(--text-muted);">${vc.focus}</div>
    </div>
    <div style="padding:12px;background:var(--bg-surface-2);border-radius:8px;margin-bottom:16px;font-size:12.5px;color:var(--text-secondary);line-height:1.6;">
      ${vc.description}
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Investment Details</div>
      <div class="modal-field"><span class="modal-field-label">Stage</span><span class="modal-field-val">${vc.stage}</span></div>
      <div class="modal-field"><span class="modal-field-label">Ticket Size</span><span class="modal-field-val" style="color:var(--gold)">${vc.ticketSize}</span></div>
      <div class="modal-field"><span class="modal-field-label">Portfolio</span><span class="modal-field-val">${vc.portfolioCount}+ companies</span></div>
      <div class="modal-field"><span class="modal-field-label">Active Since</span><span class="modal-field-val">${vc.vintage}</span></div>
      <div style="margin-top:8px;">${sectorTags}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Recent Portfolio Companies</div>
      <div class="pf-list">${portfolioHtml}</div>
    </div>
    ${backedInPipeline.length ? `
    <div class="modal-section">
      <div class="modal-section-title">In Sparrow Pipeline (backed by ${vc.name})</div>
      ${backedInPipeline.map(c => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
          <div>
            <span style="font-size:13px;font-weight:600;">${c.name}</span>
            <span class="tag tag-sector-${c.sector.toLowerCase()}" style="margin-left:6px;font-size:10px;">${c.sector}</span>
          </div>
          <span class="tag tag-urgency-${c.urgency.toLowerCase()}" style="font-size:10px;">${c.urgency}</span>
        </div>`).join('')}
    </div>` : ''}
    <div class="modal-section">
      <div class="modal-section-title">Co-Investment Strategy</div>
      <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;">
        <strong style="color:var(--gold);">Signal:</strong> When ${vc.name} backs a company, treat it as a strong validation signal.<br>
        <strong style="color:var(--gold);">Action:</strong> Monitor ${vc.name} portfolio announcements on LinkedIn/Twitter. Add new portfolio companies to Sparrow pipeline within 48 hours of announcement.
      </div>
    </div>
    ${vc.website ? `<div style="margin-top:16px;"><a href="${vc.website}" target="_blank" class="btn btn-secondary btn-sm">🔗 Visit Website</a></div>` : ''}`;
}

// ─── OUTREACH LAB ─────────────────────────────────────────────────
function renderOutreach() {
  document.getElementById('page-title').textContent = 'Outreach Lab';
  document.getElementById('page-subtitle').textContent = 'Generate personalized cold emails with reciprocity hooks';

  const companies = State.companies.filter(c => c.status !== 'Pass');
  const selectedId = State.selectedOutreachCompany || (companies[0] && companies[0].id);
  const selected = companies.find(c => c.id === selectedId) || companies[0];

  const emailType = State.selectedEmailTab || 'cold';
  const email = selected ? Outreach.getEmail(selected, emailType) : null;

  const sidebarHtml = companies.map(c => `
    <div class="outreach-company-item ${c.id === (selected && selected.id) ? 'selected' : ''}"
      onclick="State.selectedOutreachCompany='${c.id}';renderOutreach()">
      <div class="outreach-company-name">${c.name}</div>
      <div class="outreach-company-meta">${c.sector} · ${c.urgency} Urgency · Score: ${c.thesisScore}</div>
    </div>`).join('');

  const emailHtml = email ? `
    <div class="email-template-tabs">
      <button class="email-tab ${emailType==='cold'?'active':''}" onclick="State.selectedEmailTab='cold';renderOutreach()">Cold Intro</button>
      <button class="email-tab ${emailType==='warm'?'active':''}" onclick="State.selectedEmailTab='warm';renderOutreach()">Warm Intro Request</button>
      <button class="email-tab ${emailType==='followup'?'active':''}" onclick="State.selectedEmailTab='followup';renderOutreach()">Follow-Up</button>
    </div>
    <div class="email-preview">
      <div class="email-header">
        <div class="email-subject">${email.subject}</div>
        <div class="email-field" style="margin-top:8px;"><span class="email-field-label">To:</span><span class="email-field-val">${email.to}</span></div>
      </div>
      <div class="email-reciprocity-box">
        <strong>💡 Reciprocity Hook (The "Useful Thing"):</strong><br>
        ${selected.reciprocityHook || 'No specific hook defined for this company'}
      </div>
      <div class="email-body">${email.body}</div>
      <div class="email-actions">
        <button class="btn btn-primary" onclick="Export.copyToClipboard(document.querySelector('.email-body').innerText)">📋 Copy Email</button>
        <button class="btn btn-secondary" onclick="Export.copyToClipboard(document.querySelector('.email-subject').innerText)">Copy Subject</button>
        <button class="btn btn-ghost" onclick="CRM.updateStatus('${selected.id}','Outreach Sent');Toast.show('Status updated to Outreach Sent','success')">Mark as Sent</button>
      </div>
    </div>` : '<div class="empty-state"><div class="empty-icon">✉</div><div class="empty-title">Select a company to generate outreach</div></div>';

  document.getElementById('view-container').innerHTML = `
    <div class="outreach-layout">
      <div class="outreach-sidebar">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);margin-bottom:8px;">SELECT COMPANY</div>
        ${sidebarHtml}
      </div>
      <div>${emailHtml}</div>
    </div>`;
}

// ─── SETTINGS ─────────────────────────────────────────────────────
function renderSettings() {
  document.getElementById('page-title').textContent = 'Settings';
  document.getElementById('page-subtitle').textContent = 'Configure API keys, thesis parameters, and integrations';

  document.getElementById('view-container').innerHTML = `
    <div class="settings-grid">
      <div class="settings-card">
        <div class="settings-card-title">🤖 AI Enrichment (Optional)</div>
        <div class="settings-card-desc">Add Gemini API key to enable AI-powered company brief generation and thesis scoring enrichment.</div>
        <div class="form-group">
          <label class="form-label">Gemini API Key</label>
          <input type="password" class="form-input" id="gemini-key" placeholder="AIzaSy..." value="${State.settings.geminiKey}">
        </div>
        <button class="btn btn-primary btn-sm" onclick="State.settings.geminiKey=document.getElementById('gemini-key').value;State.saveSettings();Toast.show('Gemini key saved','success')">Save Key</button>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">🔍 Google Search (Optional)</div>
        <div class="settings-card-desc">Add Google Custom Search API key to enable live web research for companies and founders.</div>
        <div class="form-group">
          <label class="form-label">Google Custom Search API Key</label>
          <input type="password" class="form-input" id="google-key" placeholder="AIzaSy..." value="${State.settings.googleKey}">
        </div>
        <button class="btn btn-primary btn-sm" onclick="State.settings.googleKey=document.getElementById('google-key').value;State.saveSettings();Toast.show('Google key saved','success')">Save Key</button>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">📐 Sparrow Thesis Parameters</div>
        <div class="settings-card-desc">Current investment thesis configuration. Edit to customize scoring weights.</div>
        <div class="form-group">
          <label class="form-label">Geography Focus</label>
          <input type="text" class="form-input" value="India" readonly style="opacity:0.6">
        </div>
        <div class="form-group">
          <label class="form-label">Preferred Stages</label>
          <input type="text" class="form-input" value="Pre-Seed, Seed" readonly style="opacity:0.6">
        </div>
        <div class="form-group">
          <label class="form-label">Target Sectors</label>
          <input type="text" class="form-input" value="Fintech, B2B, AI, Consumer" readonly style="opacity:0.6">
        </div>
        <div class="form-group">
          <label class="form-label">Ticket Range</label>
          <input type="text" class="form-input" value="$1M – $2M" readonly style="opacity:0.6">
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">📊 CRM Data Management</div>
        <div class="settings-card-desc">Export your pipeline or reset to seed data.</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="Export.toCSV()">↗ Export Full Pipeline (CSV)</button>
          <button class="btn btn-ghost btn-sm" onclick="if(confirm('This will reset all CRM data to seed data. Continue?')){localStorage.removeItem('sparrow_crm');State.init();Toast.show('CRM reset to seed data','info');renderSettings();}">🔄 Reset to Seed Data</button>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:6px;">
            Pipeline: ${State.companies.length} companies · 
            ${State.companies.filter(c=>c.status==='New Signal').length} new · 
            ${State.companies.filter(c=>c.status==='Pass').length} passed
          </div>
        </div>
      </div>

      <div class="settings-card" style="grid-column:1/-1;">
        <div class="settings-card-title">➕ Add Company Manually</div>
        <div class="settings-card-desc">Add a company to the pipeline manually if you've found a signal not yet in the feed.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group">
            <label class="form-label">Company Name *</label>
            <input type="text" class="form-input" id="add-name" placeholder="e.g. AcmePay">
          </div>
          <div class="form-group">
            <label class="form-label">Website</label>
            <input type="text" class="form-input" id="add-website" placeholder="https://...">
          </div>
          <div class="form-group">
            <label class="form-label">Sector *</label>
            <select class="form-input" id="add-sector">
              <option>Fintech</option><option>B2B</option><option>AI</option><option>Consumer</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Stage *</label>
            <select class="form-input" id="add-stage">
              <option>Pre-Seed</option><option>Seed</option><option>Series A</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Signal Type</label>
            <select class="form-input" id="add-signal">
              <option>Founding Engineer Hire</option>
              <option>YC Alumni</option>
              <option>Ex-Employer Trend</option>
              <option>VC Portfolio</option>
              <option>Shark Tank Funded</option>
              <option>Raise Announced</option>
              <option>Angel Portfolio Update</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Urgency</label>
            <select class="form-input" id="add-urgency">
              <option>High</option><option>Medium</option><option>Low</option>
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label class="form-label">Description *</label>
            <input type="text" class="form-input" id="add-desc" placeholder="One-line description of what they build">
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label class="form-label">Why Now</label>
            <input type="text" class="form-input" id="add-whynow" placeholder="The catalyst / timing rationale">
          </div>
          <div class="form-group" style="grid-column:1/-1;">
            <label class="form-label">Founder Pedigree (comma-separated)</label>
            <input type="text" class="form-input" id="add-pedigree" placeholder="e.g. IIT Bombay, Ex-Razorpay, Ex-CRED">
          </div>
        </div>
        <button class="btn btn-primary" style="margin-top:12px" onclick="
          const name=document.getElementById('add-name').value.trim();
          const desc=document.getElementById('add-desc').value.trim();
          if(!name||!desc){Toast.show('Name and description are required','error');return;}
          CRM.addCompany({
            name,
            website:document.getElementById('add-website').value.trim(),
            sector:document.getElementById('add-sector').value,
            stage:document.getElementById('add-stage').value,
            geography:'India',
            hq:'India',
            description:desc,
            founderPedigree:document.getElementById('add-pedigree').value.split(',').map(s=>s.trim()).filter(Boolean),
            signalType:document.getElementById('add-signal').value,
            urgency:document.getElementById('add-urgency').value,
            whyNow:document.getElementById('add-whynow').value.trim(),
            whySparrow:'',
            recommendedAction:'Research and reach out',
            backedBy:[],
            reciprocityHook:'',
          });
          Router.navigate('signals');
        ">➕ Add to Pipeline</button>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// 15. ROUTER
// ══════════════════════════════════════════════════════════════════
const Router = {
  views: {
    dashboard:  renderDashboard,
    signals:    renderSignals,
    departures: renderDepartures,
    linkedin:   renderLinkedIn,
    pipeline:   renderPipeline,
    followups:  renderFollowups,
    investors:  renderInvestors,
    vcs:        renderVCs,
    outreach:   renderOutreach,
    memos:      renderMemos,
    settings:   renderSettings,
  },

  navigate(viewName) {
    if (!this.views[viewName]) viewName = 'dashboard';
    State.currentView = viewName;

    // Update nav
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.view === viewName);
    });

    // Render view
    this.views[viewName]();

    // Update signal badge
    const count = State.companies.filter(c=>c.status==='New Signal').length;
    const badge = document.getElementById('signal-count');
    if (badge) badge.textContent = count;
    const depBadge = document.getElementById('departure-count');
    if (depBadge) depBadge.textContent = getDepartures().length;
    const fuBadge = document.getElementById('followup-count');
    if (fuBadge) { fuBadge.textContent = Followups.counts().needsAttention; }
    const memoBadge = document.getElementById('memo-count');
    if (memoBadge) memoBadge.textContent = getMemos().length;
  },

  init() {
    document.getElementById('sidebar-nav').addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item) return;
      e.preventDefault();
      const view = item.dataset.view;
      if (view) this.navigate(view);
    });

    document.getElementById('modal-close-btn').addEventListener('click', () => Modal.close({target:document.getElementById('modal-overlay')}));
    document.getElementById('modal-overlay').addEventListener('click', (e) => Modal.close(e));

    this.navigate('dashboard');
  },
};

// ══════════════════════════════════════════════════════════════════
// 16. INITIALIZATION
// ══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  State.init();
  Router.init();
  Scanner.updateLastScanLabel();

  // Update badge
  const count = State.companies.filter(c=>c.status==='New Signal').length;
  const badge = document.getElementById('signal-count');
  if (badge) badge.textContent = count;

  console.log(`%c🐦 Sparrow Capital Sourcing OS v${CONFIG.version}`,
    'font-size:16px;font-weight:bold;color:#F59E0B;background:#080B14;padding:8px 12px;border-radius:8px;');
  console.log(`%c${State.companies.length} companies loaded · ${State.investors.length} investors tracked · ${State.vcs.length} VCs monitored`,
    'color:#94A3B8;font-size:12px;');
});
