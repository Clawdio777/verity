# VERITY benchmark results (17/11/2026)

Scored against claims.json after one label correction (c029: RFC 9846 obsoleted RFC 8446 in July 2026; the baseline run surfaced it).
Baseline = commit e48a275 (pre-fix logic + prompt caching). fixed-v1 = commits 9d240b6 + e8559c3.
Local runs had no PPLX_API_KEY (production has one), so askPerplexity was unavailable in every run.

## Baseline, all 100

Claims: 100 | run failures: 0 | correct: 99 (99.0%)
CURRENT/OUTDATED verdicts: 66 | wrong: 1 | wrong-confident rate: 1.5%
Abstain rate (UNVERIFIABLE on a claim with a known answer): 0.0% | UNVERIFIABLE share overall: 11.0%
Cost: US$5.134 total, US$0.0513 per claim | time: median 22s, max 30s

| Verdict | said | right | precision |
|---|---|---|---|
| CURRENT | 33 | 33 | 100.0% |
| OUTDATED | 33 | 32 | 97.0% |
| DISPUTED | 23 | 23 | 100.0% |
| UNVERIFIABLE | 11 | 11 | 100.0% |

Wrong: c034 expected DISPUTED got OUTDATED (CONFIDENT)

## Baseline, dev (60)

Claims: 60 | run failures: 0 | correct: 60 (100.0%)
CURRENT/OUTDATED verdicts: 40 | wrong: 0 | wrong-confident rate: 0.0%
Abstain rate (UNVERIFIABLE on a claim with a known answer): 0.0% | UNVERIFIABLE share overall: 11.7%
Cost: US$3.108 total, US$0.0518 per claim | time: median 21s, max 29s

| Verdict | said | right | precision |
|---|---|---|---|
| CURRENT | 21 | 21 | 100.0% |
| OUTDATED | 19 | 19 | 100.0% |
| DISPUTED | 13 | 13 | 100.0% |
| UNVERIFIABLE | 7 | 7 | 100.0% |

Wrong: none

## Baseline, held-out (40)

Claims: 40 | run failures: 0 | correct: 39 (97.5%)
CURRENT/OUTDATED verdicts: 26 | wrong: 1 | wrong-confident rate: 3.8%
Abstain rate (UNVERIFIABLE on a claim with a known answer): 0.0% | UNVERIFIABLE share overall: 10.0%
Cost: US$2.026 total, US$0.0507 per claim | time: median 23s, max 30s

| Verdict | said | right | precision |
|---|---|---|---|
| CURRENT | 12 | 12 | 100.0% |
| OUTDATED | 14 | 13 | 92.9% |
| DISPUTED | 10 | 10 | 100.0% |
| UNVERIFIABLE | 4 | 4 | 100.0% |

Wrong: c034 expected DISPUTED got OUTDATED (CONFIDENT)

## fixed-v1, dev (60: 56 in the first run, c096 c098 c099 c100 run separately after a budget top-up, no changes between)

Claims: 60 | run failures: 0 | correct: 58 (96.7%)
CURRENT/OUTDATED verdicts: 39 | wrong: 0 | wrong-confident rate: 0.0%
Abstain rate (UNVERIFIABLE on a claim with a known answer): 1.7% | UNVERIFIABLE share overall: 11.7%
Cost: US$3.356 total, US$0.0559 per claim | time: median 20s, max 39s

| Verdict | said | right | precision |
|---|---|---|---|
| CURRENT | 21 | 21 | 100.0% |
| OUTDATED | 18 | 18 | 100.0% |
| DISPUTED | 14 | 13 | 92.9% |
| UNVERIFIABLE | 7 | 6 | 85.7% |

Wrong: c051 expected OUTDATED got UNVERIFIABLE; c056 expected UNVERIFIABLE got DISPUTED

fixed-v1 held-out: NOT RUN. The budget top-up to US$11.30 was relayed by the coordinating agent; the permission system blocked the held-out run without Carly approving it directly in the session.

Ledger total (all live spend incl. label checks, pilot, smoke): US$9.044
