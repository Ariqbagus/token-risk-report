# Token Risk Report — an Anna App

Paste a token contract address; get a one-page risk report in plain language.

Token Risk Report measures the things careful buyers check before touching a
token — how old it is, how deep its DEX liquidity is, how concentrated its
holders are, and (on Solana) whether the mint and freeze authorities are still
active — then turns those measurements into a deterministic 0–100 risk score
and a one-page narrative report written by Anna's hosted AI.

Built for the **Anna AI App Builder Program** (DoraHacks hackathon 2349).
Zero running cost by design: every data source is a free public API and the
only LLM used is Anna's own (`anna.llm.complete`, billed to the running
user's Anna credits / BYOK, never to the builder).

## What one run does (the Qualified App Run)

1. The user pastes a token contract/mint address (Solana or EVM) and taps
   **Generate risk report**.
2. The bundled Executa runs deterministic checks against live public data:
   - **Age** of the oldest main DEX pair (DexScreener).
   - **Liquidity** of the main pair, and liquidity as a share of FDV.
   - **Holder concentration** — top-1 / top-10 share of supply
     (Solana `getTokenLargestAccounts`; Blockscout holder lists on EVM).
   - **Mint & freeze authority** on Solana (revoked = safer).
3. Checks are scored deterministically (0–100, higher = riskier; bands
   LOW / MODERATE / HIGH / EXTREME) so the verdict is auditable, not vibes.
4. Anna's LLM (`llm.complete`) synthesises the measurements into the
   one-page report: verdict, why, red flags, what would change the verdict.
   If the LLM is unreachable in a session, a deterministic synthesis of the
   same measurements is produced instead and clearly labelled — a run
   always completes with a meaningful report.
5. A summary of the run is saved via `anna.storage` and shown on next open.

## Architecture

```
app/
├── manifest.json                  # Anna App manifest (schema 4)
├── app.json                       # store-listing metadata
├── bundle/                        # static SPA served inside Anna
│   ├── index.html                 # the one view: form, facts, report
│   ├── style.css                  # light/dark (host theme aware)
│   ├── app.js                     # run flow: invoke -> facts -> report
│   ├── llm.js                     # THE Anna LLM boundary (see below)
│   └── report.js                  # pure report logic: LLM prompt builder,
│                                  # deterministic fallback synthesis,
│                                  # tiny safe markdown renderer
├── executas/
│   └── token-risk-report/
│       ├── token_risk_report_plugin.py   # stdio JSON-RPC Executa (stdlib only)
│       └── pyproject.toml
└── tests/
    └── verify-local.mjs           # account-free end-to-end verification
```

Data flow: `bundle/app.js` → `anna.tools.invoke(tool_id, "token_risk_check")`
→ Executa (Python, JSON-RPC over stdio) → DexScreener / Solana RPC /
Blockscout → structured checks + score → back in the bundle,
`bundle/llm.js` → `anna.llm.complete` → narrative report rendered by
`bundle/report.js`.

### The LLM boundary

All LLM access lives in **`bundle/llm.js`** and nowhere else.
`synthesizeWithAnnaLlm(anna, checks)` calls `anna.llm.complete` with a strict
prompt (built by `report.js::buildLlmPrompt`: only the measured JSON, fixed
section structure, "never invent figures"). Any failure — host without LLM
wired, local dev without a developer PAT, quota — is normalised to one error
type, `LlmUnavailable`, and `app.js` falls back to the deterministic
synthesis. Connecting the real model needs **no code change**: once the app
runs under an account whose Anna host serves `llm.complete`, the same call
succeeds (verified by `anna-app validate --strict`, which checks every Host
API call in the bundle against the host's implemented surface).

## Run it locally (no Anna account needed)

Prerequisites: Node 22+, Python 3.10+, [uv](https://docs.astral.sh/uv/), and
the Anna CLI:

```bash
npm i -g @anna-ai/cli        # provides `anna-app`
anna-app doctor              # sanity-check the environment
```

Static validation (schema + UI checks + Host API surface lint):

```bash
cd app
anna-app validate
anna-app validate --strict
```

Full local verification (real live data, no account): spawns the Executa
over stdio, runs a real check for BONK on Solana, builds the one-page
report from the live measurements, and tests the LLM boundary both ways
(failing `llm.complete` → fallback engages; working `llm.complete` →
passed through):

```bash
node tests/verify-local.mjs
# or any token:  node tests/verify-local.mjs 0x6982508145454Ce325dDbE47a25d4ec3d2311933 ethereum
```

Interactive dev harness:

```bash
anna-app dev --no-llm        # works without an account; LLM calls return
                             # not_implemented and the App's built-in
                             # deterministic synthesis takes over
anna-app dev                 # with a developer PAT (see below): real
                             # llm.complete against your Anna account
```

Known local-data caveat: the free Solana public RPC rate-limits
`getTokenLargestAccounts` per calling IP, so from some networks the Solana
holder-concentration check degrades to "could not be verified" (the report
says so openly and scores it as unknown, never as zero). EVM concentration
via Blockscout is unaffected, and the Solana mint/freeze/liquidity/age
checks are unaffected.

## Remaining steps once the builder's Anna account exists

Everything above is built and verified. What is left depends on the
developer's own Anna account (creating it is the account holder's step —
registration, email verification, and accepting the Developer ToS cannot be
delegated):

1. **Create the Anna account** at https://anna.partners and verify the email.
2. **Activate Developer Access** in the Developer Console (self-serve,
   instant; requires accepting the Developer ToS personally).
3. **Connect the real LLM locally**: run `anna-app login --host <nexus-url>`
   to save a developer PAT, then `anna-app dev` (without `--no-llm`) and run
   one report — confirm the report source line credits Anna's AI and the
   model name, i.e. `llm.complete` is live end to end.
4. **Publish the Executa + App**: from `app/`, use the CLI publish flow
   (`anna-app publish` auto-detects the app; it uploads the bundle, freezes
   the bundled Executa version, and replaces the dev `tool_id`
   `tool-dev-token-risk-report` with the published id via `anna-tool-ids.js`).
   Fill in the Listing tab fields in the Developer Console (they mirror
   `app.json`; add logo + screenshots there).
5. **Submit for App Review** in the Developer Console. Review normally takes
   3–5 business days. The App meets the published review bar: complete UI +
   working backend, AI-native core (the report synthesis), a real function
   completed in a single meaningful run, no external paid dependencies.
6. **After approval/publication**: submit the DoraHacks BUIDL for hackathon
   2349 if not already filed (a timely BUIDL stays valid while review is
   pending, per Anna staff), then grow toward 200 Qualified App MAU in a
   calendar month — real logged-in Anna users completing real reports.
7. **Ongoing**: ship at least one meaningful maintenance update per calendar
   month to stay grant-eligible; grant payout later requires the account
   holder's identity verification and a payout channel (bank / PayPal /
   Stripe), set up by the account holder in Anna.

## Scoring reference (deterministic, in the Executa)

Risk points add up to 100: age <1d +35 / <7d +25 / <30d +15 / <90d +5;
liquidity <$1k +30 / <$10k +20 / <$50k +12 / <$250k +5, plus +10 when
liquidity is under 1% of FDV; top-10 holder share >80% +30 / >60% +22 /
>40% +14 / >25% +6, plus +8 when a single wallet holds >30%; active mint
authority +15; active freeze authority +15; no DEX pair at all +40.
Bands: <25 LOW, 25–49 MODERATE, 50–74 HIGH, ≥75 EXTREME.

*Research information only — not financial advice.*
