# Regular screen → Score → OpenAI: integration record

The scheduled pipeline now starts with the completed regular research screen, not a
fresh leaderboard subset. Its checked-in cohort is
`packages/backend/fixtures/regular-screened-cohort-20261006.json`: 10,987 public
addresses (10,889 traders, 96 HyperCore vaults, 2 ERC-4626 vaults), screened at
2026-10-06 14:01:48 UTC under policy
`b25561c3d86cf2ed4082e04659a8d91f2c994122b2e39a3a1bea1ac395bd16e8`.
The fixture's SHA-256 is
`6287c70b79c3fe15b4b1d211f1afc438a646677b306fa6ea7d8eadae503025e9`.
It contains addresses and classifications only, not API keys, account histories,
trade fills or model prompts. It was generated from the completed local
`screening.json` (SHA-256
`876bfb59ee1b4df335efcb57d08100b735c5932551680742e2e40e13e4c02e45`),
cross-checked against the local ingest SQLite address set and kind labels.

Every 12 hours, `scan()` registers those addresses and refreshes their live
metadata from the leaderboard and vault lists. The metadata sources cannot add
unscreened addresses. `refresh()` then obtains current `portfolio` histories and
equity. Score chooses up to 250 from the refreshed cohort. The qualified list
gets recent fills for trade-count and high-frequency checks; every 10 minutes,
Score selects up to 40 non-high-frequency finalists. The existing server-side
OpenAI Role, Risk and Red-Team review runs when that set changes or its bench
expires. Approved finalists enter the roster, which still caps actual copy
sources at 15. Model prose has no direct order or sizing authority.

In an isolated local replay using the saved October 7 input snapshot, the first
Score evaluated all 10,987 addresses in 17.9 seconds and selected 250. Of those,
40 had over 100 distinct orders per day in their saved fills; the second Score
evaluated the remaining 210 in 0.16 seconds and selected 40 (39 traders, one
HyperCore vault). These are selection counts, not approval or return results.
The isolated live review then read public positions and fills and called the
configured GPT-6 Sol OpenAI API for Role, Risk and Red-Team. All three calls
returned HTTP 200 with structured responses (235,487 total tokens). The
existing basic fallback approved five of the 40 finalists for its bench; four
passed the subsequent hold gate. The strict candidate gate passed one of 40,
and its manifest was `INVALID_BUCKET` (`CAPACITY`), so this is **not** a
verified freeze or a live-trading authorization. Saved score histories and
the review's live evidence have different observation times. Raw public reads,
model outputs and account-level review details remain in ignored local files,
not in Git; this document records only aggregate counts and outcomes.

Deploy in order: apply
`supabase/migrations/20261008040000_regular_screened_cohort.sql`, ensure the
backend's server-only `OPENAI_API_KEY` is present, deploy, run the scan, and
watch `/api/backend/pipeline` for `accounts.listed = 10987`, the refreshed
count, the qualified count, a 40-finalist selection and a persisted review.
The dashboard displays the cohort → 250 → 40 provenance. The first cold start
waits for refreshed portfolio data; it cannot safely rank addresses from the
fixture alone. This record does not claim a deployed Vercel run or funded trade.
