-- ── Payment claims (22/10/2026) ────────────────────────────────────────────────
-- VERITY settles an x402 payment only after the work succeeds. To stop one signed payment getting the
-- work done twice, each payment (sha256 of its signed payload) is claimed here before any work starts.
-- A second insert with the same id fails on the primary key and is refused (409).
-- Server-only: written with the service role, never exposed to anon or authenticated clients.
-- Same design as AEONOS 004_payment_claims.sql.

create table if not exists public.payment_claims (
  id          text primary key,             -- sha256 hex of the signed x402 payload
  created_at  timestamptz not null default now()
);

alter table public.payment_claims enable row level security;

drop policy if exists "admin_all" on public.payment_claims;
create policy "admin_all" on public.payment_claims
  for all to service_role using (true) with check (true);

revoke all on public.payment_claims from anon, authenticated;
grant select, insert, update, delete on public.payment_claims to service_role;
