import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bearerMatches } from "../api/_bearer";

// 23/10/2026 security check: the cron checks matched "Bearer undefined" when CRON_SECRET was unset.
// They must fail closed.
describe("bearerMatches", () => {
  test("the right secret passes", () => {
    expect(bearerMatches("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(bearerMatches("Bearer s3cret-value", " s3cret-value\n")).toBe(true);
  });

  test("a missing or empty secret refuses everything", () => {
    for (const secret of [undefined, "", "   "]) {
      expect(bearerMatches("Bearer ", secret)).toBe(false);
      expect(bearerMatches("Bearer undefined", secret)).toBe(false);
      expect(bearerMatches(undefined, secret)).toBe(false);
      expect(bearerMatches("", secret)).toBe(false);
    }
  });

  test("wrong, partial, unprefixed or missing tokens are refused", () => {
    expect(bearerMatches("Bearer wrong", "s3cret-value")).toBe(false);
    expect(bearerMatches("Bearer s3cret", "s3cret-value")).toBe(false);
    expect(bearerMatches("s3cret-value", "s3cret-value")).toBe(false);
    expect(bearerMatches(undefined, "s3cret-value")).toBe(false);
    expect(bearerMatches(["Bearer s3cret-value"], "s3cret-value")).toBe(true);
  });

  test("every protected route uses it, and no fallback secret is left in the code", () => {
    for (const f of ["api/daily-summary.ts", "api/cron-check-deps.ts"]) {
      expect(readFileSync(f, "utf8")).toContain("bearerMatches(");
    }
    expect(readFileSync("api/cron-check-deps.ts", "utf8")).not.toMatch(/CRON_SECRET \|\| "/);
  });
});
