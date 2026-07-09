// ============================================================================
// Sparrow Sourcing OS — shared crawl helpers
// ----------------------------------------------------------------------------
// Anti-hallucination guard, sector classification, and light thesis scoring,
// shared by scripts/firecrawl-scan.js (live crawl) and scripts/clean-fabricated.js
// (one-time cleanup) so both apply exactly the same rules.
// ============================================================================
'use strict';

// Aggregator / index / macro / social pages that carry NO clean per-deal data.
// The structured extractor hallucinates placeholder companies from these, so we
// never trust a raise whose only provenance is one of them. Specific per-deal
// article and snippet URLs (entrackr.com/snippets/…, dated weekly-report
// articles, inc42.com/buzz/from-x-to-y…) are NOT matched here and are trusted.
const UNRELIABLE_SOURCE_RE = new RegExp([
  'techcrunch\\.com/2025/12/27',                                // macro year-in-review article
  'entrackr\\.com/monthly-funding-report(?:$|[?#])',            // bare monthly index
  'entrackr\\.com/weekly-funding-report-weekly-funding-report(?:$|[?#])', // bare weekly index
  'entrackr\\.com/tags?/funding(?:-news)?(?:$|[?#/])',          // funding tag index
  'vccircle\\.com/category/startup(?:$|[?#])',                  // category index
  'x\\.com/',                                                   // social feed
  'twitter\\.com/',
].join('|'), 'i');

// Placeholder text the model emits when it fabricates an example rather than
// extracting a real deal. Matched against the whole record (name + founders +
// investors). Kept deliberately specific so real companies aren't caught.
const PLACEHOLDER_RE = new RegExp([
  '\\bjohn doe\\b', '\\bjane smith\\b', '\\bbob johnson\\b', '\\bmark smith\\b',
  '\\bemily white\\b', '\\bjane doe\\b',
  '\\bfounder [a-e]\\b', '\\binvestor [a-e]\\b', '\\bnotable investor\\b',
  '\\bventurex\\b', '\\bangel investors network\\b', '\\bexample (?:corp|inc|ventures)\\b',
  '\\bstartups? inc\\.?\\b', '\\bacme\\b', '\\bplaceholder\\b', '\\blorem\\b',
].join('|'), 'i');

// Generic template company names the model emits as filler — a GENERIC PREFIX
// plus a GENERIC SUFFIX ("Tech Innovators", "AI Innovations", "Green Solutions"),
// or an obvious placeholder prefix ("XYZ Tech", "ABC Health", "123 SaaS"), or a
// suffix-letter template ("TechStartupA", "EcoStartupB"). Deliberately requires
// BOTH halves so real single-word brands (HealthifyMe, TechGenix, CloudHealth)
// and real "<Brand> Solutions" names (Antier Solutions) are NOT caught.
const GENERIC_PREFIX = '(?:tech|ai|edtech|edutech|agritech|fintech|healthtech|deeptech|green|eco|food|smart|cloud|sustain)';
const GENERIC_SUFFIX = '(?:innovations?|innovators?|solutions?)';
const TEMPLATE_NAME_RE = new RegExp([
  `^(?:xyz|abc|123)\\b`,                          // XYZ Tech, ABC Health, 123 SaaS
  `^${GENERIC_PREFIX}(?:\\s+\\w+)?\\s+${GENERIC_SUFFIX}$`, // Tech Innovators, Green Tech Solutions
  `^(?:techstartup|ecostartup|foodtech|healthtech|fintech)[a-e]$`, // TechStartupA, FoodTechC
].join('|'), 'i');

function isFabricated(rec) {
  const name = (rec.name || rec.company || '').trim();
  if (!name) return false;
  // Placeholder founders/investors anywhere in the record ("John Doe",
  // "Investor C", "Notable Investor") — the strongest fabrication tell.
  if (PLACEHOLDER_RE.test(JSON.stringify(rec))) return true;
  if (TEMPLATE_NAME_RE.test(name)) return true;
  return false;
}

// Sector classification into the fund's four buckets. Word-boundary matched so
// "AI" no longer matches "hair"/"retail" (the old includes('ai') bug that sent
// everything to Consumer). Order encodes thesis priority: Fintech > AI > B2B >
// Consumer (Consumer is the catch-all).
function canonSector(raw) {
  const s = (raw || '').toLowerCase();
  if (/\bfin\s?tech\b|wealth\s?tech|neo\s?bank|lending|payments?|insur\s?tech|\bbank\b|blockchain|crypto|defi/.test(s)) return 'Fintech';
  if (/\bai\b|artificial intelligence|machine learning|\bml\b|\bllm\b|deep\s?tech|legal ai|semiconductor|robotics|generative/.test(s)) return 'AI';
  if (/\bb2b\b|\bsaas\b|enterprise|supply\s?chain|logistics|dev\s?tools?|infrastructure|\bapi\b|\biot\b|prop\s?tech|real estate tech|cyber/.test(s)) return 'B2B';
  return 'Consumer';
}

// Hard-tech / deep-tech sectors that fall outside the fund's seed software
// thesis (per references/sourcing-context.md — hardware, spacetech, defence,
// EV, packaging get dropped off-thesis). Used only to down-rank urgency.
const OFF_THESIS_RE = /space\s?tech|aerospace|defen[cs]e|\bev\b|electric vehicle|mobility|hardware|semiconductor|packaging|clean\s?tech|battery|drone|manufactur/i;

// Light thesis score for a crawled raise, mirroring app.js Scorer's dimensions
// (Geography 30 · Stage 25 · Sector · Signal) with no pedigree data available.
function scoreCrawled(c) {
  let geo = 0, stage = 0, sector = 0, signal = 2;
  if (/india/i.test(c.geography || '')) geo = 30;
  if (['Pre-Seed', 'Seed'].includes(c.stage)) stage = 25;
  else if (c.stage === 'Series A') stage = 10;
  const sec = canonSector(c.subSector || c.sector);
  sector = sec === 'Fintech' ? 20 : sec === 'AI' ? 19 : sec === 'B2B' ? 17 : 12;
  // small bump for a concretely-evidenced raise (named investor)
  if (Array.isArray(c.backedBy) && c.backedBy.length) signal = 4;
  return Math.min(geo + stage + sector + signal, 100);
}

// Urgency for a crawled raise. A genuinely fresh in-thesis raise with a named
// investor is a real "reach out now" signal (High). Off-thesis hard-tech is Low.
// Everything else is Medium — instead of the old blanket High.
function deriveUrgency(c) {
  const sub = c.subSector || c.sector || '';
  if (OFF_THESIS_RE.test(sub)) return 'Low';
  const sec = canonSector(sub);
  const inThesisCore = ['Fintech', 'AI', 'B2B'].includes(sec);
  const hasInvestor = Array.isArray(c.backedBy) && c.backedBy.length > 0;
  if (inThesisCore && hasInvestor) return 'High';
  return 'Medium';
}

module.exports = {
  UNRELIABLE_SOURCE_RE, PLACEHOLDER_RE, TEMPLATE_NAME_RE, OFF_THESIS_RE,
  isFabricated, canonSector, scoreCrawled, deriveUrgency,
};
