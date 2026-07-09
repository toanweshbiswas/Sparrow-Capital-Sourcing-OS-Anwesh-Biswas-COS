// Thin PostgREST client for Supabase — plain fetch, no @supabase/supabase-js
// dependency (this project has none and the calls we need are simple).
// Auth: service_role key only, per db/schema.sql (RLS is on with no public
// policies; service_role bypasses it). Never expose this key to the browser.
'use strict';

function client(url, serviceRoleKey) {
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  // Fetch every row of a {id|key, data jsonb} table, ordered by its key column.
  async function selectAll(table, keyCol = 'id') {
    const res = await fetch(`${base}/${table}?select=${keyCol},data&order=${keyCol}.asc`, { headers });
    if (!res.ok) throw new Error(`Supabase select ${table} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Upsert rows (each {[keyCol]: ..., data: ...}) in one request.
  async function upsert(table, rows, keyCol = 'id') {
    if (!rows.length) return;
    const res = await fetch(`${base}/${table}?on_conflict=${keyCol}`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Supabase upsert ${table} failed: ${res.status} ${await res.text()}`);
  }

  // Replace a table's full contents with `rows` (delete anything not present).
  // Used for migration/sync where the local JSON file is the whole world.
  async function replaceAll(table, rows, keyCol = 'id') {
    await upsert(table, rows, keyCol);
    const keep = rows.map(r => r[keyCol]);
    const res = await fetch(
      `${base}/${table}?${keyCol}=not.in.(${keep.map(k => `"${k}"`).join(',') || '""'})`,
      { method: 'DELETE', headers }
    );
    if (!res.ok) throw new Error(`Supabase prune ${table} failed: ${res.status} ${await res.text()}`);
  }

  return { selectAll, upsert, replaceAll };
}

module.exports = { client };
