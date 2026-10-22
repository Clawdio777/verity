-- 23/10/2026: the verity schema never had grants for service_role, so every insert/select from the API
-- failed and nothing was ever saved (0 rows in verification_log, caller_memory, tasks since launch).
-- This breaks the log, caller memory and async mode. Internal tables: service_role only, no anon/authenticated.
-- Undo: revoke all on all tables in schema verity from service_role; revoke usage on schema verity from service_role;
grant usage on schema verity to service_role;
grant select, insert, update, delete on all tables in schema verity to service_role;
grant usage, select on all sequences in schema verity to service_role;
alter default privileges in schema verity grant select, insert, update, delete on tables to service_role;
alter default privileges in schema verity grant usage, select on sequences to service_role;
