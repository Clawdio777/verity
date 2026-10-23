import { timingSafeEqual } from "node:crypto";

/**
 * True only when the request carries `Bearer <secret>` and the secret is actually set.
 * Fails closed (23/10/2026 security check): `token !== (env || "")` let an empty token through when the
 * env var was missing, `Bearer ${undefined}` matched "Bearer undefined", and a fallback secret sat in this
 * public repo.
 */
export function bearerMatches(header: string | string[] | undefined, secret: string | undefined): boolean {
  const expected = (secret ?? "").trim();
  const value = Array.isArray(header) ? header[0] : header;
  if (!expected || !value?.startsWith("Bearer ")) return false;
  const a = Buffer.from(value.slice(7).trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
