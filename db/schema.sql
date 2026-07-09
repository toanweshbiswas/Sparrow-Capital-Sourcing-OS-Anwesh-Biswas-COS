-- Sparrow Sourcing OS — Supabase schema
-- JSON-per-row: each entity is stored as {id, data jsonb}, matching the app's
-- object-shaped data. Run this once in the Supabase SQL editor.

create table if not exists companies  (id text primary key, data jsonb not null, updated_at timestamptz default now());
create table if not exists investors  (id text primary key, data jsonb not null, updated_at timestamptz default now());
create table if not exists vcs         (id text primary key, data jsonb not null, updated_at timestamptz default now());
create table if not exists departures  (id text primary key, data jsonb not null, updated_at timestamptz default now());
create table if not exists memos       (id text primary key, data jsonb not null, updated_at timestamptz default now());
create table if not exists meta        (key text primary key, data jsonb not null, updated_at timestamptz default now());

-- The server uses the service_role key and talks to these directly, so we keep
-- RLS enabled with no public policies (service_role bypasses RLS). This means
-- the anon/public key cannot read or write — all access goes through our server.
alter table companies  enable row level security;
alter table investors  enable row level security;
alter table vcs        enable row level security;
alter table departures enable row level security;
alter table memos      enable row level security;
alter table meta       enable row level security;
