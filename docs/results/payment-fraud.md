# Results: payment fraud — the domain where the right answer is known in advance

How the domain is built, where its data comes from and what traps the generator
holds are in the [domain description](../domains/payment-fraud.md). In short: the
domain runs on synthetic data shaped like IEEE-CIS, **its label is generated
independently of every feature**, so the right answer to each measurement is
known in advance and any lift over chance means leakage in the engine. A domain
conceived as proof of the core/plugin boundary turned out along the way to be an
executable honesty test for the whole platform — a null hypothesis.

This report is short by construction: a null hypothesis has few degrees of
freedom. The numbers are from the runs of 2026-08-31. What is **not** measured here is in §6.

## 1. Backtest: ROC-AUC has to be 0.5 — and it is

Three monthly walk-forward windows, the same protocol as the credit domain
(training on matured labels, calibration on a temporal split, not one random
partition). The whole run takes 30 seconds.

| test window |  events | fraud rate | ROC-AUC | PR-AUC |    Brier |     ECE | ECE, wtd. | curve bins |
| ----------- | ------: | ---------: | ------: | -----: | -------: | ------: | --------: | ---------: |
| 1970-03     | 102,315 |      3.53% |  0.4915 | 0.0345 | 0.034098 | 0.00106 |   0.00144 |          1 |
| 1970-04     |  98,991 |      3.46% |  0.4988 | 0.0347 | 0.033422 | 0.00091 |   0.00094 |          1 |
| 1970-05     |  97,768 |      3.56% |  0.5042 | 0.0357 | 0.034359 | 0.00003 |   0.00058 |          1 |

ROC-AUC 0.492–0.509 against an expected 0.5. PR-AUC 0.0346–0.0361 against a base
rate of 3.46–3.56% — the PR-AUC of a random classifier equals the positive rate,
and it does. The "1970" dates are the relative `TransactionDT` scale (seconds
from an unknown origin), not a calendar.

**There is no fourth window, and its absence is a result too.** The data ends on
29 June; a fraud label is confirmed over a 30-day horizon, so by the end of the
data not one June transaction has a confirmed label — the engine produces an
empty test window and skips the step with the reason logged. An early version of
this table contained a 1970-06 window: it existed only because three live smoke
events with an `ingestedAt` in 2026 pushed "the end of the data" half a century
forward and everything looked matured. The May tail was 4,719 events longer for
the same reason. The smoke events were deleted, and the numbers in the table are
the ones with an honest boundary.

**The calibration curve collapses to a point.** A model with nothing to learn
gives nearly the same number to everyone (0.03638 against an actual 0.03532): in
all three windows the curve has a single bin, which the showcase renders
as one point on the diagonal. That is the signature of an honest constant
predictor — a many-binned curve on this data would mean the model had "found"
something.

**The weighted-ECE skew is unreadable here.** The ratio of weighted to plain ECE
is only meaningful where the model discriminates; on a constant model it becomes
a division of two near-zero numbers (×22 in the 1970-05 window is
0.00058 / 0.000026).

## 2. The control month: the realized loss has to land in the body of the distribution

The credit episode `crisis_2009` checks that the portfolio layer **sees a
crisis**. The control episode of the null domain checks the opposite: that the
layer **does not invent a crisis where there is none**. The label is independent
of the features and correlation is declared zero — realized losses have to be
covered by ordinary simulation paths rather than escaping into the tail.

Episode `control_month`: the portfolio as of 1970-06-01 (the last month whose
labels mature before the data runs out), model trained up to the same date,
lookback 30 days, position being the transaction itself (a flow):

|                |                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| positions      | 99,164, of which 94,445 are comparable                                                                 |
| dropped        | 4,719 — the label cannot be confirmed before the data ends, and the report prints this as its own line |
| exposure       | $24.04m                                                                                                |
| predicted (EL) | $831,428                                                                                               |
| realized       | $866,580                                                                                               |
| gap            | **×1.042**                                                                                             |
| in counts      | 3,266.2 expected / 3,346 actual (×1.024)                                                               |

The loss distribution at the declared ρ = 0 (50,000 paths, fixed seed):
σ = 16,389, VaR 99% = 870,223, worst path 903,634. The built-in check on the
simulation: an analytic mean of 831,428 against a simulated 831,435 — a
difference of 0.001%.

**The realized loss landed on the 98.25th percentile** — 876 paths out of 50,000
are worse. That is inside the support: a bad outcome, but one covered by
ordinary paths. The contrast with the credit domain is the whole point of the
pair of episodes: there, at a correlation honestly measured before the crisis,
the realized loss lay **beyond the worst of all 50,000 paths**.

Caveats without which 98.25% cannot be read:

- A single observation with a one-sided p ≈ 0.018 does not separate noise from a
  slight calibration shift. The shift is visible directly, because the right
  answer is known here: the model predicted a rate of 3.458%, the month gave
  3.543% — a difference of 0.085 pp against a monthly σ of the rate of 0.06 pp,
  that is one and a half sigma.
- Those 0.085 pp were enough to move from the middle to the 98th percentile: at
  94 thousand positions the portfolio percentile is highly sensitive to error in
  the probability estimates. This illustrates the main caveat of the
  distribution — it answers "how bad can it get **if** the probabilities are
  right", and even on the null domain the price of a tiny calibration error
  shows up as a shift in the percentile.
- In money the deviation (2.1σ) is larger than in counts (1.4σ): this month's
  fraud happened to fall on slightly larger amounts. On a domain where the
  amount is independent of the label by construction, that is noise.
- The date of the episode was chosen by a rule, not by search: the last month
  with matured labels. The moment is set in the domain declaration and is not in
  the request body.

## 3. Cases: on a null domain there is nothing to analyse

The named-case machinery works for the domain — five cases open with a full
feature vector. But a "hit" and a "miss" from a constant model on a random label
are random rows by construction: they have no cause and no analysis, and writing
one would mean inventing a story about noise. The case walkthrough is a section
of the credit domain (`credit-risk.md`, §7), where the model has something to
analyse.

## 4. Scenario stress

`amount_spike` (amounts ×3 at the same frequency): EL 898,735 → 2,520,005,
**+180%**, 73,703 positions affected; the portfolio sits on the domain's own
relative time scale, lookback 30 days, and the run takes 9.5 s. A quirk of the
domain: `TransactionAmt` is
both a feature source and the exposure field, so the shock moves both sides of
ΔEL; that never happens with mortgages (the rate and LTV are shocked, while what
is at risk is the outstanding balance). ΔEL is meaningful here because both the
probability and the exposure are computed by the same engine — but it cannot be
read as "fraud risk": the probability is constant and the entire move comes from
exposure.

## 5. What this domain proved in the core

Plugging in a second domain cost the core one file with zero domain words — and
uncovered four dormant defects invisible on the first domain:

- the `distinct` aggregate produced invalid SQL (it was declared but never
  executed);
- events without an aggregation axis got a global aggregate instead of `null`
  (`PARTITION BY` treats NULLs as equal; on credit both axes are mandatory);
- a `TRUNCATE` without a `pluginId` scope wiped the neighbouring domain on
  reload;
- a shock on the exposure field did not move the amount at risk.

Each is closed by a test on a fixture, not by a patch for the domain.

## 6. What these results do not prove

- **Calibration on real fraud.** The synthetic label is random; what the model
  can do on the real IEEE-CIS is unknown and is not claimed here. Calibration is
  measured on the credit domain, where there are 26.5M real events.
- **The full shape of the real data.** The generator reproduces neither the join
  with `train_identity.csv` (in the synthetic data every column is in one file)
  nor correlations between features.
- **Ingestion delay.** On load `ingestedAt = occurredAt`; the contract
  distinguishes late-arriving events in a real stream, but the project has no
  data with a real delay yet.

## 7. How to reproduce

The environment is prepared once — `npm install`, `.env`, the scoring venv,
migrations ([guide](../guide.md), §3). Then:

```bash
./scripts/up.sh                                    # postgres
node scripts/synthetic-csv.mjs --rows 590000 --out data/synthetic.csv
# absolute paths: the loader runs from apps/backend
PLUGIN=payment_fraud COHORTS= \
  SOURCE=$PWD/plugins/payment-fraud/source.json DATA=$PWD/data \
  ./scripts/ingest.sh                              # the whole dataset, one run
npm run windows -w @mamir/backend -- --plugin payment_fraud --what labels
npm run windows -w @mamir/backend -- --plugin payment_fraud --what features
npm run dev -w @mamir/scoring &                    # :8001
npm run backtest -w @mamir/backend -- \
  --plugin payment_fraud --from 1970-03-01 --steps 4 --step-months 1   # 30 s
```

The control month goes over HTTP with the core running
(`npm run dev -w @mamir/backend`); the moment of the episode is set in the
declaration:

```bash
curl -X POST localhost:3001/history/control_month/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"payment_fraud","lookback":"30d","scenarios":50000}'   # ~100 s
```

The distribution chart is drawn by the same code as in the showcase:
`npm run charts -w @mamir/frontend` → `reports/distribution-control.svg`.

The synthetic generator is seeded (`--seed 42` by default), the model is seeded,
the simulation is seeded — a repeat run gives the same numbers to the last digit.
