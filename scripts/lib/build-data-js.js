// Builds the data.js source text served to the browser, from plain JS values
// (companies/investors/vcs/departures/memos arrays + a lastScan object).
// Shared by scripts/regenerate-data-js.js (local-file source) and
// scripts/scan-server.js (live Supabase source) so both stay byte-identical
// in shape.
'use strict';

function buildDataJs({ companies, investors, vcs, departures, memos, lastScan }) {
  const banner = `/* ================================================================
   Sparrow Capital Sourcing OS — data.js
   GENERATED FILE — do not hand-edit.
   ================================================================ */
'use strict';

`;

  const body =
    `const SEED_COMPANIES = ${JSON.stringify(companies, null, 2)};\n\n` +
    `const SEED_INVESTORS = ${JSON.stringify(investors, null, 2)};\n\n` +
    `const SEED_VCS = ${JSON.stringify(vcs, null, 2)};\n\n` +
    `const SEED_DEPARTURES = ${JSON.stringify(departures, null, 2)};\n\n` +
    `const SEED_MEMOS = ${JSON.stringify(memos, null, 2)};\n\n` +
    `const LAST_SCAN = ${JSON.stringify(lastScan, null, 2)};\n`;

  return banner + body;
}

module.exports = { buildDataJs };
