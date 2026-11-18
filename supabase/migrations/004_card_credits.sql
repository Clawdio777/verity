-- ── Card credits (18/11/2026) ──────────────────────────────────────────────────────
-- Replaces the PayGate proxy that ran on Railway. Card buyers' `pg_` keys and credit balances for AEONOS and
-- VERITY live here (one shared database). The key itself is never stored: only its sha256 hash.
-- Every balance change is written to credit_ledger. A failed call is refunded once (unique per charge),
-- and a Stripe checkout tops up once (unique per session). Card credits only: no USDC/x402 money moves here.
-- Server-only: service_role, never anon or authenticated.
-- Same file as AEONOS 005_card_credits.sql. VERITY uses the AEONOS database (project wwglcsdolnvgrdzgoumg), where it
-- was applied on 18/11/2026, so nothing needs applying here; re-running it is a no-op apart from replacing the functions.
-- Undo: drop function credit_charge, credit_refund, credit_topup; drop table credit_ledger, credit_keys.

create table if not exists public.credit_keys (
  key_hash      text primary key,                      -- sha256 hex of the full pg_ key
  agent         text not null check (agent in ('aeonos', 'verity')),
  key_prefix    text not null,                         -- first 10 characters, for support lookups
  name          text,
  credits       integer not null default 0 check (credits >= 0),
  total_spent   integer not null default 0,
  total_calls   integer not null default 0,
  active        boolean not null default true,
  source        text not null default 'checkout',      -- 'checkout' or 'railway-import'
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create table if not exists public.credit_ledger (
  id             bigserial primary key,
  key_hash       text not null references public.credit_keys(key_hash),
  agent          text not null,
  delta          integer not null,
  reason         text not null check (reason in ('import', 'topup', 'charge', 'refund')),
  tool           text,
  ref            text,                                 -- Stripe session id (topup) or charge id (refund)
  balance_after  integer not null,
  created_at     timestamptz not null default now()
);

create index if not exists credit_ledger_key_idx on public.credit_ledger (key_hash, created_at desc);
create unique index if not exists credit_ledger_one_topup  on public.credit_ledger (ref) where reason = 'topup';
create unique index if not exists credit_ledger_one_refund on public.credit_ledger (ref) where reason = 'refund';

alter table public.credit_keys   enable row level security;
alter table public.credit_ledger enable row level security;

drop policy if exists "admin_all" on public.credit_keys;
create policy "admin_all" on public.credit_keys   for all to service_role using (true) with check (true);
drop policy if exists "admin_all" on public.credit_ledger;
create policy "admin_all" on public.credit_ledger for all to service_role using (true) with check (true);

revoke all on public.credit_keys, public.credit_ledger from anon, authenticated;
grant select, insert, update, delete on public.credit_keys, public.credit_ledger to service_role;
grant usage, select on sequence public.credit_ledger_id_seq to service_role;

-- Take p_amount credits, atomically. Refuses (ok = false) when the key is unknown, inactive or short.
create or replace function public.credit_charge(p_agent text, p_key_hash text, p_amount integer, p_tool text)
returns table (ok boolean, charge_id bigint, balance integer, reason text)
language plpgsql set search_path = public as $$
declare v_bal integer; v_active boolean; v_id bigint;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  update credit_keys k
     set credits = k.credits - p_amount, total_spent = k.total_spent + p_amount,
         total_calls = k.total_calls + 1, last_used_at = now()
   where k.key_hash = p_key_hash and k.agent = p_agent and k.active and k.credits >= p_amount
  returning k.credits into v_bal;
  if found then
    insert into credit_ledger (key_hash, agent, delta, reason, tool, balance_after)
    values (p_key_hash, p_agent, -p_amount, 'charge', p_tool, v_bal) returning id into v_id;
    return query select true, v_id, v_bal, null::text;
    return;
  end if;
  select k.credits, k.active into v_bal, v_active from credit_keys k where k.key_hash = p_key_hash and k.agent = p_agent;
  if not found then return query select false, null::bigint, 0, 'not_found'; return; end if;
  if not v_active then return query select false, null::bigint, v_bal, 'inactive'; return; end if;
  return query select false, null::bigint, v_bal, 'insufficient';
end $$;

-- Give back the credits of one charge (a failed call). Safe to call twice: the second call changes nothing.
create or replace function public.credit_refund(p_charge_id bigint)
returns integer
language plpgsql set search_path = public as $$
declare c credit_ledger%rowtype; v_bal integer;
begin
  select * into c from credit_ledger where id = p_charge_id and reason = 'charge';
  if not found then raise exception 'charge % not found', p_charge_id; end if;
  if exists (select 1 from credit_ledger where reason = 'refund' and ref = p_charge_id::text) then
    select credits into v_bal from credit_keys where key_hash = c.key_hash; return v_bal;
  end if;
  update credit_keys set credits = credits - c.delta, total_spent = total_spent + c.delta
   where key_hash = c.key_hash returning credits into v_bal;
  insert into credit_ledger (key_hash, agent, delta, reason, tool, ref, balance_after)
  values (c.key_hash, c.agent, -c.delta, 'refund', c.tool, p_charge_id::text, v_bal);
  return v_bal;
end $$;

-- Add a paid Stripe checkout's credits to its key (created here on first payment). Once per session.
create or replace function public.credit_topup(p_agent text, p_key_hash text, p_key_prefix text, p_name text,
                                               p_credits integer, p_ref text)
returns table (applied boolean, balance integer)
language plpgsql set search_path = public as $$
declare v_bal integer;
begin
  if p_credits is null or p_credits <= 0 or p_ref is null then raise exception 'bad topup'; end if;
  insert into credit_keys (key_hash, agent, key_prefix, name, credits, source)
  values (p_key_hash, p_agent, p_key_prefix, p_name, 0, 'checkout')
  on conflict (key_hash) do nothing;
  if exists (select 1 from credit_ledger where reason = 'topup' and ref = p_ref) then
    select credits into v_bal from credit_keys where key_hash = p_key_hash;
    return query select false, v_bal; return;
  end if;
  update credit_keys set credits = credits + p_credits
   where key_hash = p_key_hash and agent = p_agent returning credits into v_bal;
  if not found then raise exception 'key belongs to another agent'; end if;
  insert into credit_ledger (key_hash, agent, delta, reason, ref, balance_after)
  values (p_key_hash, p_agent, p_credits, 'topup', p_ref, v_bal);
  return query select true, v_bal;
end $$;

revoke all on function public.credit_charge(text, text, integer, text) from public, anon, authenticated;
revoke all on function public.credit_refund(bigint) from public, anon, authenticated;
revoke all on function public.credit_topup(text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.credit_charge(text, text, integer, text) to service_role;
grant execute on function public.credit_refund(bigint) to service_role;
grant execute on function public.credit_topup(text, text, text, text, integer, text) to service_role;
