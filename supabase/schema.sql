-- Run this once in your Supabase project's SQL editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- Creates the `routes` table that Rouleur syncs saved rides to, with
-- row-level security so each account can only ever see or modify its own
-- rows — there is no way for one user's routes to be visible to another.

create table if not exists public.routes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  profile text,
  loop boolean default false,
  distance double precision,
  gain double precision,
  start jsonb,
  waypoints jsonb,
  coords jsonb
);

alter table public.routes enable row level security;

create policy "Users can view their own routes"
  on public.routes for select
  using (auth.uid() = user_id);

create policy "Users can insert their own routes"
  on public.routes for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own routes"
  on public.routes for update
  using (auth.uid() = user_id);

create policy "Users can delete their own routes"
  on public.routes for delete
  using (auth.uid() = user_id);

create index if not exists routes_user_id_idx on public.routes (user_id);
