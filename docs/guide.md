# MAMIR by hand: from an empty database to the showcase

This is not an architecture document but a user guide: what objects live in the
system, which commands fill it, in what order, what appears after each step and
how to read what the showcase displays. What the system measured is in the
domain reports.

## 1. The model of the world in six words

The core knows nothing about any subject area — it operates on six concepts, and
a domain (a plugin) declares what each of them is for it:

| core word    | for mortgages (`credit_risk`)                             | for fraud (`payment_fraud`)                             |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| **event**    | a monthly servicing record of a loan                      | a card transaction                                      |
| **axis**     | loan number, state                                        | card, address                                           |
| **feature**  | "delinquencies of this loan over 365 days"                | "amount on this card over 24 hours"                     |
| **label**    | "default within the next 12 months?"                      | "fraud (confirmed within 30 days)?"                     |
| **exposure** | outstanding balance; the position is the loan (**stock**) | the amount; the position is the event itself (**flow**) |
| **scenario** | "rate +3 pp", "LTV ×1.4 in CA/FL/NV"                      | "amounts ×3"                                            |

All of this the plugin **declares as data**, not code: the event schema in
`plugins/<domain>/source.json`, everything else in the declaration at
`plugins/<domain>/src/index.ts`. The core always does the computing. When the id
of a scenario or a historical episode is needed below, it comes from that
declaration.

Two rules that explain everything the system does afterwards:

- **Data enters the database only through the loader.** No seeds, no upload
  form: an invented row is indistinguishable from a measured one, so there is a
  single path and it is reproducible by command.
- **The showcase computes nothing.** It displays stored runs from the database.
  An empty tab is not a broken showcase but a missing run; heavy calculations
  are launched by hand (CLI or curl) and cost minutes on the balance-sheet
  domain.

## 2. The loading pipeline

Every domain goes through the same chain. What each step does:

1. **Load** (`scripts/ingest.sh`) — CSV → the `Event` table. The loader
   validates rows against `source.json`, journals into `IngestRun` (a repeat run
   skips completed slices, an aborted one is rolled back) and, at the end,
   builds the indexes on the domain's axes itself.
2. **Labels** (`windows --what labels`) — for every event the core answers the
   declaration's question "how did this end" and records the moment the answer
   became known. A label "matures": an event can be trained on only once its
   horizon has passed — otherwise the model learns from the future.
3. **Features** (`windows --what features`) — point-in-time `FeatureVector`
   rows: the value of each feature as of the event, based on what was **known**
   at that moment (`ingestedAt`, strictly before `t`).
4. **Backtest** (`npm run backtest`) — walk-forward: at each step the model
   trains on matured history before the start of the test window, scores the
   window, computes metrics and picks named cases. The result is rows in the
   database that the showcase renders on the Metrics and Cases tabs. This is
   also the only step where a model appears — real-time scoring and the runs
   below use its versions.
5. **Scenarios and history** (curl against a running core) — scenario stress
   ("what happens if") and historical episodes ("what the model said and what
   came out", optionally with a loss distribution). The results are the Stress
   and History tabs.

Steps 1–4 are offline and do not need the core running (the Python sidecar is
needed for the backtest). Step 5 is HTTP against a running core.

## 3. The fast path: synthetic fraud, about 15 minutes

The best way to understand the system is to run it end to end on the second
domain: the data is generated on the spot, no external accounts are needed, and
the whole chain takes minutes. Prepare the environment once:

```bash
npm install
cp apps/backend/.env.example apps/backend/.env
npm run setup -w @mamir/scoring        # venv + Python dependencies
./scripts/up.sh                        # postgres, waits for healthy
npm run prisma:migrate -w @mamir/backend
```

Then the pipeline from §2, verbatim:

```bash
node scripts/synthetic-csv.mjs --rows 590000 --out data/synthetic.csv
# absolute paths: the loader runs from apps/backend
PLUGIN=payment_fraud COHORTS= \
  SOURCE=$PWD/plugins/payment-fraud/source.json DATA=$PWD/data \
  ./scripts/ingest.sh                              # step 1, ~1 min
npm run windows -w @mamir/backend -- --plugin payment_fraud --what labels
npm run windows -w @mamir/backend -- --plugin payment_fraud --what features
npm run dev -w @mamir/scoring &                    # sidecar on :8001
npm run backtest -w @mamir/backend -- \
  --plugin payment_fraud --from 1970-03-01 --steps 4 --step-months 1   # 30 s
```

After the backtest, bring up the core with the showcase and look at it:

```bash
npm run dev -w @mamir/backend &                    # :3001
npm run dev -w @mamir/frontend &                   # :3000
```

On `localhost:3000` pick the `payment_fraud` domain: three windows with ROC-AUC
around 0.5. That is the right answer — the synthetic label is independent of the
features by construction, and any lift would be leakage
([analysis](results/payment-fraud.md)). There is no fourth window, and that is a
result too: labels on June events did not mature before the data ran out, and
the engine skipped the step on its own.

The last step of the pipeline is a historical episode with a loss distribution
(the id `control_month` is declared in the domain):

```bash
curl -X POST localhost:3001/history/control_month/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"payment_fraud","lookback":"30d","scenarios":50000}'   # ~100 s
```

After it the History tab shows the control month: a gap of ×1.04 and the
realized loss inside the distribution — what a null domain is obliged to show.

## 4. The full path: the mortgage domain

The same thing, but the data is real and the volumes are different: 26.5M
events, the full chain about an hour (per-step timings are in
[results/credit-risk.md](results/credit-risk.md), §10).

**Data.** The Freddie Mac Single-Family Loan-Level Dataset is downloaded by hand
under your own account (Clarity; redistribution is prohibited, which is why it
is neither in the repository nor in the git history). You need the sample files
for origination years 1999–2007, a pair per cohort, in `data/freddie-mac/`:

```
sample_orig_1999.txt   # origination: score, LTV, rate, state...
sample_svcg_1999.txt   # servicing: monthly records for every loan
```

**Pipeline** (all `ingest.sh` defaults are tuned for this domain):

```bash
./scripts/ingest.sh                                # ~5 min, cohorts in parallel
npm run windows -w @mamir/backend -- --plugin credit_risk --what labels
npm run windows -w @mamir/backend -- --plugin credit_risk --what features
npm run dev -w @mamir/scoring &
npm run backtest -w @mamir/backend -- --plugin credit_risk --from 2005-01-01 --steps 6
```

Cohorts load in parallel processes (`JOBS=4` by default): with `COPY` doing
the writing, the bottleneck is CSV parsing and Zod validation in Node, which is
single-threaded.

Then the portfolio layer over HTTP (with the core running): the
`high_ltv_rate_shock` / `regional_shock` scenarios, the `crisis_2009` /
`spike_2020` episodes, the ρ band. The exact commands, each with what it costs,
are in §10 of the report; there is no need for a second copy of them here.

To reload a domain from scratch, run `./scripts/ingest.sh --fresh` (it clears
only its own domain). To stop the environment, run `./scripts/down.sh`.

## 5. How to read the showcase

Top right is the domain selector; everything on screen belongs to the selected
domain. Four tabs:

- **Metrics** — the table of backtest windows and the charts of the selected
  window: the calibration curve (predicted probability against observed
  frequency; the ideal is the diagonal) and deciles by amount at risk (does the
  error grow where the money is). What matters here is not the level of the
  metrics but how they diverge across windows: ranking (ROC-AUC) and the scale
  of the probabilities (Brier, ECE) break at different moments.
- **Cases** — named cases from the window: hits, a **miss** and a false alarm,
  each with its feature vector as of the event. The miss is shown in as much
  detail as the hits — that is a rule of the project. On synthetic fraud the
  cases are random rows by construction and there is nothing to analyse there.
- **Stress** — stored scenario runs. Read them as a triple: ΔEL (how much
  expected loss was added) → reach (how far the shock actually got; zero
  modified rows and "the portfolio is resilient" both give ΔEL = 0) →
  extrapolation share (how much of the answer came from where the model was
  never trained).
- **History** — "predicted against realized" episodes and, if the run was
  launched with `scenarios`, the loss distribution: VaR, ES and the exact
  percentile of the realized loss among the simulated paths.

The tabs read stored runs over `GET /backtests`, `/backtests/:id/cases`,
`/scenarios/runs` and `/history/runs`; nothing is recomputed on click.

## 6. Real-time scoring

A running core scores events synchronously — features in pointwise form plus an
HTTP call to the sidecar, p50 32 ms:

```bash
curl -X POST localhost:3001/events -H 'content-type: application/json' \
  -d '{"pluginId": "credit_risk", "payload": { ...fields from the domain source.json }}'
```

On 26.5M ingested events, 50 sequential requests:

| stage                      |   p50 |   p95 |
| -------------------------- | ----: | ----: |
| 8 features, pointwise form |  4 ms |  5 ms |
| HTTP call to scoring       | 22 ms | 28 ms |
| whole pipeline             | 32 ms | 43 ms |

The per-stage split is printed in the `featureMs` and `scoreMs` fields of the
`events.service.ingest.accepted` log line.

If the sidecar is down or the domain model has not been trained yet, the event
is still accepted and the vector stored — the response carries `score: null`; a
domain fact is not lost because ML is down. The latency measurement is
reproducible rather than taken on faith:
`npm run bench -w @mamir/backend -- --plugin credit_risk --count 50` (the
benchmark deletes everything it creates — in a research database the write path
belongs to the loader).

## 7. Checking that it is all honest

- `npm test` from the root — the core (60 tests, against a separate
  `mamir_test` database) and the scoring service (33), needing Postgres but not
  the rest of the stack; every answer worked out by hand or known analytically.
- `npm run windows -w @mamir/backend -- --plugin credit_risk --what verify --sample 400`
  — equivalence of the two forms of a feature (windowed and pointwise): 3,200
  pairs, 0 mismatches.
- `npm run boundary` — the core does not reference the plugins.
- `npm test -w @mamir/frontend` — the showcase against a live core, every tab of
  both domains.

## 8. Pitfalls

- **Data paths must be absolute** (`SOURCE=$PWD/...`, `DATA=$PWD/...`): the
  loader runs from `apps/backend`, and a relative path quietly points somewhere
  else.
- **The showcase only works on `localhost:3000`** (`strictPort`): the core's
  CORS is open on exactly that port, and a neighbouring one produces a confusing
  request error.
- **`score: null` in the `/events` response** is not an intake error: either the
  sidecar is not running (`npm run dev -w @mamir/scoring`) or the domain has
  never been backtested, so there is no model version at all.
- **Empty Stress/History** means there were no runs: they are launched by curl
  from §3–4, and nothing is recomputed on click.
- **Do not create events by hand in the research database.** The engine takes
  "the end of the data" as the maximum `ingestedAt` of the domain; three smoke
  events once moved it half a century forward, immature labels passed for
  matured, and the backtest table gained a window that does not exist
  ([analysis](results/payment-fraud.md)). If you want to poke at `POST /events`,
  poke at the test database or clean up after yourself, the way `bench` does.
- **If data was loaded bypassing `ingest.sh`**, build the axis indexes:
  `npm run windows -w @mamir/backend -- --plugin <id> --what indexes`. Without
  them a pointwise feature is a full scan of the event table, and every scoring
  call costs seconds instead of milliseconds.
