# Results: mortgage credit risk

A report on what came out of the real Freddie Mac data. How the domain is built
and what traps the subject area holds are in the
[domain description](../domains/credit-risk.md); this file carries only the
conclusions and the numbers.

Named cases come from the run of 2026-08-04; metrics, portfolio, scenarios and
historical runs from 2026-08-06. Every metric is quoted together with its time
window: a metric without a window means nothing.

The run is reproducible: the model is seeded, the extraction is fully ordered,
and repeating the command gives the same numbers to the last digit — verified by
five independent runs. Each retrained all six models from scratch, and all six
ROC-AUC values matched character for character. The last run, on 6 August,
introduced loss given default into the expected-loss formula: the money amounts
shrank by exactly a factor of 0.47, while frequencies, exposure and every ratio
did not move by a digit — what is reproducible is not only reading the data but
training as well.

---

## In brief: what this domain produced

Four results; each is worked through in its own section, this is the summary.

1. **Monitoring on ROC-AUC alone is blind to a crisis.** Through 2008–2009
   ranking barely dropped (0.935 → 0.818 → 0.931 — noise on a dashboard), while
   the error in the probabilities grew 7.4-fold on Brier and 14.9-fold on ECE:
   the model was right about _who_ was riskier and wrong about _how much_.
   The analysis is in §6.
2. **The error sat where the money was, and the sign of the relationship
   flipped.** In the calm year 2006 large loans defaulted four times less often
   than small ones, and the model learned that correctly; in 2009 the
   understatement grows monotonically across balance deciles, from ×1.7 on small
   loans to ×4.5 on large ones. The 2010 "recovery" on average metrics is the
   cancellation of two errors (overstatement on small loans, understatement on
   large ones) that net out on average but not in a portfolio. §8.
3. **The portfolio layer measures what event metrics cannot see by
   construction.** ROC, Brier and ECE are computed over events with no weight: a
   $50k loan enters them the same way a $700k one does. Exposure-weighted ECE
   crossed one on the 2007 window — **a year** before AUC noticed anything was
   wrong (§4); predicted against realized losses for the 2009 portfolio were
   $161.4m against $546.4m, a factor of ×3.39 (§8).
4. **"Was 2009 even possible in the model's opinion."** At a correlation
   honestly measured on the calm years, the realized loss lies beyond the worst
   of all 50,000 paths — the model declares what happened impossible; at the
   Basel ρ = 0.15 it is a tail of roughly once in 77 years. A ready-made argument
   for why Basel prescribes a correlation rather than letting you measure one.
   §8.

Compressed into one sentence: **event metrics fail to see a crisis not because
they are computed badly but because they are computed without position weight;
a layer with exposure sees it a year earlier and shows which decile the error
sits in.** That is the difference between a classifier with a dashboard and a
risk engine.

A caveat that strengthens the conclusion rather than weakening it: the baselines
(§5) showed that the 2007 skew appears for **any** predictor, down to sorting on
a single column with no training. It is a property of the crisis — it moved onto
large positions — not a gap in one particular model; the credit belongs not to
gradient boosting but to the measurement frame that makes the shift visible.

---

## 1. What this is about, in two paragraphs

Freddie Mac is a US mortgage agency. It publishes anonymized data on the
mortgages it holds: who took a loan and when, for how much, at what rate, and
**what happened to that loan every month** — how much is still owed, whether
payments are on time, whether the house has been repossessed.

I took a sample from 1999–2007 and train a model to answer the question:
**"will something seriously bad happen to this loan within the next year?"**
Not "is this a good borrower in general", but a forecast over a horizon —
because that is how risk management in a bank actually works.

### Important: the year in the filename is the origination year, not the year of the events

This is the first thing everyone trips over. The file `sample_2007` is not "data
for 2007". It is **50,000 mortgages issued in 2007**, together with their entire
subsequent payment history — right up to 2025.

| file |  loans |    events | record span       |
| ---- | -----: | --------: | ----------------- |
| 1999 | 50,000 | 2,502,277 | 1999-01 … 2025-09 |
| 2003 | 50,000 | 4,073,882 | 2003-01 … 2025-09 |
| 2007 | 50,000 | 3,003,932 | 2006-12 … 2025-09 |

Nine files gave **450,000 loans and 26,538,649 monthly records** — 59 records per
loan on average. That is why the data contains 2008 and 2010 even though I took
no loans originated after 2007.

### What counts as a "loss"

A loan is declared bad if at least one of the following happened:

- delinquency reached **180 days or more**;
- the collateral passed to the lender (status `RA`);
- the loan closed with a credit-event code — third-party sale, short sale, REO
  disposition.

**What is deliberately not here: prepayment.** About 85% of loans end that way,
and it is not a loss but a competing outcome — the borrower sold the house or
refinanced. Naive labelling on "the balance went to zero" would have produced
92% positives instead of 13.7%, and the model would have learned to predict
refinancing.

This is not a technical detail but the central domain decision of the whole
project.

---

## 2. What is in the data

```
loans                       450,000
monthly records          26,538,649
span                    1999-01 … 2025-09
size in the database          25 GB

defaults at loan level         13.73%
at record level                 2.87%   (761,633 out of 26.5M)
```

The difference between 13.73% and 2.87% is not an error: a loan can "default"
once while having sixty records. Only the months followed by trouble within a
year are positive.

### The 2008 crisis is visible in the raw data, with no model at all

Entries into default by year for loans originated in 2007:

```
2007      11
2008     424  ██████████████
2009   1,603  █████████████████████████████████████████████████████
2010   1,692  ████████████████████████████████████████████████████████
2011   1,113  █████████████████████████████████████
2012     757  █████████████████████████
2013     429  ██████████████
2014     230  ███████
...
2020     117  ███   ← COVID
```

The peak is December 2009, with 186 defaults in the month. The total across all
years is **6,867** — exactly what an independent script counted from the raw
files before they were loaded into the database. Two implementations in
different languages agreed to the unit, which validated the file join, date
parsing, the default definition and the order of 64 columns all at once.

**A side finding: the data holds two regime breaks, not one.** The 2020 spike
(117 against 31 in 2019) is COVID payment forbearance showing up as delinquency
status.

---

## 3. How it was validated

Not one random split of the sample. Only **walk-forward** — moving forward
through time:

```
step 1:  train on 1999–2004  →  test on 2005
step 2:  train on 1999–2005  →  test on 2006
step 3:  train on 1999–2006  →  test on 2007
step 4:  train on 1999–2007  →  test on 2008   ← the model had never seen a crisis
step 5:  train on 1999–2008  →  test on 2009
step 6:  train on 1999–2009  →  test on 2010
```

At every step the model is retrained and **knows nothing** about the data of the
next step. Plus three mandatory conditions, each easy to break in a way that
produces pretty but fake numbers:

1. **Features are computed only from the past.** As of time `t` the window
   admits events strictly earlier than `t`.
2. **Filtering is by "when it became known", not "when it happened".** An event
   that arrived late was not available as of time `t`.
3. **The label has to mature.** Training on time `t` is allowed only on outcomes
   that were already settled as of `t`.

Plus a fourth one that surfaced only while building the backtest: **labels for
the last year of history are computed on a truncated future.** The forward
window runs into the edge of the data and quietly returns "there was no loss" —
not because there was none, but because there was nowhere to look. There are
81,902 such labels, and they are excluded from the samples.

### Label maturation is two different questions, not one

The first version of the backtest applied condition 3 identically to the
training and the test sample, and that turned out to be a mistake costing 92% of
the test data.

The questions differ:

- **training** asks "what was KNOWN as of time `t`". A label has to be mature as
  of `t` itself, otherwise the model learns from labelling out of the future;
- **evaluation** asks "how did it eventually END". The report is written today,
  history is available through 2025-09, and the outcome of the test window is
  already known. The model still never looked there — the accuracy of the
  evaluation does not extend its knowledge.

One boundary for both cases meant `resolvedAt <= end of the test window`, so
with an annual window and a 365-day horizon only the first month made it into
the evaluation. The "2005 test year" was in fact a slice as of 1 January:

| test window |     was |    became |
| ----------- | ------: | --------: |
| 2005        | 135,806 | 1,782,314 |
| 2008        | 226,185 | 2,606,167 |
| 2009        | 207,959 | 2,263,057 |

The error flattered the model systematically: the January slice of 2008 is the
portfolio **before** the crisis, with a default rate of 1.06% against 2.04% over
the full year. The metrics below are recomputed on the corrected windows and are
therefore worse than the earlier ones; that is how it should be.

---

## 4. Results

| test year |    events | default rate | ROC-AUC | PR-AUC |    Brier | log-loss |     ECE | ECE, wtd. | skew |
| --------- | --------: | -----------: | ------: | -----: | -------: | -------: | ------: | --------: | ---: |
| 2005      | 1,782,314 |       0.579% |  0.9347 | 0.3298 | 0.004571 |  0.02118 | 0.00206 |   0.00184 | 0.89 |
| 2006      | 2,129,557 |       0.535% |  0.9245 | 0.2763 | 0.004438 |  0.02079 | 0.00186 |   0.00182 | 0.98 |
| 2007      | 2,505,082 |       0.727% |  0.8627 | 0.2182 | 0.006306 |  0.03146 | 0.00334 |   0.00412 | 1.24 |
| 2008      | 2,606,167 |       2.044% |  0.8175 | 0.2788 | 0.017666 |  0.08765 | 0.01428 |   0.01933 | 1.35 |
| 2009      | 2,263,057 |       4.521% |  0.8943 | 0.5072 | 0.032767 |  0.13254 | 0.02769 |   0.04018 | 1.45 |
| 2010      | 1,878,314 |       6.081% |  0.9306 | 0.6038 | 0.033760 |  0.12285 | 0.01040 |   0.02018 | 1.94 |

The run is reproducible: repeating the command gives these numbers to the last
digit, verified by five independent runs. Before 4 August that was not the case —
the extraction was sorted by `occurredAt` alone, and since the domain's
granularity is a month, row order inside a reporting period was arbitrary and the
calibration split cut off different records every time.

Reproducibility was checked at every level: each run retrained all six models
from scratch, and all six ROC-AUC values matched character for character. The run
of 5 August produced the same expected portfolio loss for 2009 as the previous
one — to the cent. So it is not only reading the data that is deterministic, but
training as well.

The run of 6 August is the only one where the amounts changed, and they changed
exactly as they should have: loss given default entered the expected-loss
formula, and every money figure shrank by a factor of 0.47
(343,407,138.427 → 161,401,355.061), while frequencies, exposure and the metrics
stayed character for character the same. The ratio of new losses to old across
the deciles of the crisis window is exactly 0.47000000 in all ten groups on both
sides. That too is a determinism check, and a stronger one: exactly what was
changed changed, and nothing else.

What the columns mean, briefly:

| metric       | in plain words                                                | better    |
| ------------ | ------------------------------------------------------------- | --------- |
| default rate | how many records actually turned out bad                      | —         |
| ROC-AUC      | can the model **tell apart** risky from non-risky             | toward 1  |
| PR-AUC       | the same, but fairer on rare events                           | toward 1  |
| Brier        | how **correct the probabilities themselves** are              | toward 0  |
| log-loss     | the same, but punishes confident mistakes harder              | toward 0  |
| ECE          | the average gap between "predicted" and "happened"            | toward 0  |
| ECE, wtd.    | the same, with each event weighted by its outstanding balance | toward 0  |
| skew         | the ratio of weighted to plain                                | see below |

**About the last two columns.** All the usual metrics are computed over events
with no weight: a $50k loan enters them exactly as a $700k one does. So they
cannot answer the question "does the model err where the money is" — not because
they are computed badly, but because they cannot see amounts at risk at all.
Weighted ECE uses the same calibration bins, but the weight of a bin is the total
outstanding balance rather than the number of records.

The ratio of the two reads as an indicator: **below one, the error sits on small
positions and the portfolio need not care; above one, it has moved to where the
money is.** The crossing happened on the 2007 window, a year before ROC-AUC
noticed the crisis. The analysis is in section 8.

---

## 5. What to compare this against

Is ROC-AUC 0.94 a lot or a little? An unanswerable question until there is a
reference point next to it. So on the same six windows, with **the same
protocol** — the same temporal split, the same isotonic calibration, the same
metrics — three baselines are computed:

- **one feature** — sorting on a single column, no training. Which column is
  chosen by AUC on the training part (choosing by the test set would be the same
  leakage); on all six steps `loan_dlq_months_365d`, months delinquent over the
  year, wins;
- **logistic regression** — a linear boundary on the same seven features (of the
  eight declared, one is empty in the training window and is excluded identically
  for every contender, see section 9). It answers whether nonlinearity pays for
  itself;
- **boosting without class weighting** — the same model without `class_weight`.

ROC-AUC:

| window | one feature | logistic reg. |   boosting | boosting, no CW |
| ------ | ----------: | ------------: | ---------: | --------------: |
| 2005   |      0.9094 |    **0.9459** |     0.9347 |          0.9392 |
| 2006   |      0.8964 |    **0.9285** |     0.9245 |          0.9272 |
| 2007   |      0.8505 |        0.8663 |     0.8627 |      **0.8702** |
| 2008   |      0.8087 |        0.8100 |     0.8175 |      **0.8318** |
| 2009   |      0.8707 |        0.8691 | **0.8943** |          0.8929 |
| 2010   |      0.9089 |        0.9212 | **0.9306** |          0.9305 |

The "one feature" and "logistic regression" columns matched the run of 27 July to
four digits, while both boosting columns moved. That is independent confirmation
of the diagnosis: the nondeterminism sat in the boosting training path, which is
sensitive to row order, whereas the baselines, indifferent to order, always
reproduced.

The recomputation of 6 August, after the extraction order was fixed and an
exposure column added to it, reproduced **all 24 cells of this table** — both
boosting columns included. The shift described in the previous paragraph was the
last one; after the extraction order was fixed it never recurred.

PR-AUC:

| window | one feature | logistic reg. |   boosting | boosting, no CW |
| ------ | ----------: | ------------: | ---------: | --------------: |
| 2005   |      0.3184 |    **0.3470** |     0.3298 |          0.3037 |
| 2006   |      0.2812 |    **0.2974** |     0.2763 |          0.2533 |
| 2007   |      0.2223 |    **0.2281** |     0.2182 |          0.2051 |
| 2008   |  **0.2851** |        0.2788 |     0.2788 |          0.2707 |
| 2009   |      0.4913 |        0.4841 | **0.5072** |          0.4976 |
| 2010   |      0.5847 |        0.5968 | **0.6038** |          0.5873 |

**Boosting adds 0.009–0.028 of ROC-AUC over a single sorted column.** The order
of risk in this data is set by the counter of months delinquent; four hundred
trees on seven features are a refinement on top of it. This does not mean "the
model is bad", it is a property of the task: a loan 11 months delinquent out of
12 will default, and noticing that requires no machine learning.

**Nonlinearity pays for itself only at a regime break.** In the calm years
2005–2006 logistic regression beats boosting (0.9459 against 0.9347), in
2007–2008 they are level, and only in the crisis year 2009 does boosting truly
pull ahead — 0.8943 against 0.8691, the largest gap in the table. Where the
relations between
features stop being linear, trees start earning their keep.

### The skew of error toward large positions is a property of the regime, not of the model

The ratio of exposure-weighted ECE to plain ECE (the "skew") had until now been
computed for boosting only, and its growth was read as a statement about the
model. The extraction now carries an exposure column, so the same ratio is
computed for all four contenders:

| window | one feature | logistic reg. | boosting | boosting, no CW |
| ------ | ----------: | ------------: | -------: | --------------: |
| 2005   |        1.37 |          0.98 |     0.89 |            0.90 |
| 2006   |        0.65 |          1.05 |     0.98 |            0.97 |
| 2007   |        1.23 |          1.30 |     1.23 |            1.18 |
| 2008   |        1.33 |          1.35 |     1.35 |            1.35 |
| 2009   |        1.46 |          1.48 |     1.45 |            1.44 |
| 2010   |        2.28 |          2.38 |     1.94 |            1.85 |

**The conclusion has to be refined.** In the calm years 2005–2006 the ratios
wobble around one in no particular pattern (0.65–1.37) — ECE there is of the
order of 0.002, and the quotient of two small numbers is noisy. From **2007**
onward all four cross one at once and grow together; in 2008 they differ by all
of 0.02 (1.33–1.35). Sorting on one column, with no training at all, produces the
same shift as four hundred trees.

So the skew measures not that the model failed to learn something but that
**the crisis moved onto large loans**, and any predictor blind to position size
takes that into its error. The phrasing "the model's error moved onto large
positions" is true as a fact, but it credited the model with something that
belongs to the regime.

The last row adds another twist: in the "recovered" year 2010 the skew is
**worse the simpler the predictor** — 2.38 for logistic regression against 1.85
for boosting without weighting. The trees partially learned a dependence on size
that a linear model on these seven features cannot express; but even for the best
of the four, error on large positions is twice the average.

**`class_weight="balanced"` does not do what it was thought to do.** The code
carried a comment saying "without weighting the model degenerates to a constant" —
that is wrong: the "boosting, no CW" column shows ROC-AUC that is even slightly
higher in four windows out of six. Weighting does not save you from a
degeneration that does not happen; it redistributes quality toward the rare
class: PR-AUC with it is higher in **all** six windows (0.3298 against 0.3037,
0.5072 against 0.4976 and so on). The parameter is useful, but its justification
is a different one.

### On Brier specifically: a small number means nothing on its own

Brier 0.0046 looks magnificent — until you compute the Brier of a predictor that
names the base rate for everyone and does nothing else. At a default rate of
0.579% such a constant has Brier = 0.00576. So the "magnificent" 0.0046 is a 20%
gain over having no model at all:

| window | default rate | constant | boosting | gain |
| ------ | -----------: | -------: | -------: | ---: |
| 2005   |       0.579% |  0.00576 |  0.00457 |  21% |
| 2008   |       2.044% |  0.02002 |  0.01767 |  12% |
| 2009   |       4.521% |  0.04317 |  0.03277 |  24% |
| 2010   |       6.081% |  0.05711 |  0.03376 |  41% |

In the 2008 window the model beat the constant by only 12% — worse than in any
other. The absolute Brier values do not show this at all: 0.0177 against 0.0046
reads as "four times worse in 2008", even though the default rate itself
quadrupled.

### What these baselines do not prove

On Brier and ECE the single feature wins almost everywhere (on ECE, in all six
windows). It is tempting to read that as "simpler is better", but the conclusion
would be wrong: a single feature takes 13 integer values, isotonic regression
turns it into a staircase with thirteen levels, and a coarse predictor is
incomparably easier to calibrate — each level carries tens of thousands of
observations. The correct phrasing is: **the fewer distinct probabilities a model
names, the harder it is to be wrong about them.** That is a limitation of ECE as
a metric, not a virtue of the baseline.

---

## 6. The main conclusion

**ROC-AUC did not notice the crisis; calibration showed it.**

Look at two rows of the same table:

```
              2006      2009      ratio
ROC-AUC      0.9245    0.8943        0.97×   ← barely moved
Brier        0.004438  0.032767      7.4×
ECE          0.001857  0.027685     14.9×
```

Discriminative power slipped from 0.935 to 0.818 and came back to 0.931 — a
wobble that any dashboard would write off as noise. Over the same windows **the
error in the probabilities grew fifteenfold**.

That means literally this: the model **kept ranking borrowers correctly** — who
is riskier and who is not — while **naming numbers that had nothing to do with
what was happening**. In the crisis window it said "probability 16%" where 42%
actually happened (see the table below).

Watch AUC alone, as most ML monitoring does, and the 2008 crisis passes
unnoticed.

### What broken calibration looks like

Test window 2009, model trained through 2009-01-01:

| model predicted | what happened |    events | Kupiec LR |
| --------------: | ------------: | --------: | --------: |
|          0.40 % |        1.92 % | 2,149,208 |  64,197.8 |
|         15.95 % |       41.90 % |    45,822 |  17,428.4 |
|         25.93 % |       53.22 % |    27,636 |   9,272.1 |
|         34.70 % |       62.09 % |    24,131 |   7,487.7 |
|         44.63 % |       73.39 % |     8,666 |   2,947.7 |
|         51.39 % |       77.07 % |     5,089 |   1,425.0 |
|         61.02 % |       76.18 % |     1,041 |     107.6 |
|         72.70 % |       76.91 % |     1,464 |      13.5 |

Every row understates, and understates systematically — by roughly a factor of
two to three. The significance threshold for the Kupiec statistic is 3.84; here
it reaches 64,198.

**Bin size is printed next to the statistic, and that is not decoration.** In the
first version of the backtest the test window was a one-day slice, and the
second-to-last bin held 23 events: 56.35% predicted, 56.52% happened, statistic
0.0 — perfect calibration. The test failed to reject the hypothesis not because
the model was right but because **it had no power on a sample that size**.
Without bin size beside it, that green cell read as an achievement. On full
windows the smallest bin holds 1,041 events and the artefact disappeared on its
own; but it disappeared because the window was fixed, not because it was
harmless.

### A separate effect: the model cannot say "very likely"

The calibrated probability of a model trained before the crisis **never rises
above 0.8 for any input**: the highest non-empty bin of the calibration curve
runs from 0.7 to 0.8, and the named cases top out at 0.7647. The cause is
twofold, and separating it is more honest than lumping it together:

- isotonic calibration was fitted on a pre-crisis window where such a default
  frequency was never observed. The model has never seen confidence higher than
  that;
- `IsotonicRegression(out_of_bounds="clip")` **physically** cannot return more
  than the maximum encountered while fitting the calibrator. That is a property
  of the method, not a fact about the world: Platt scaling would have no ceiling.

How large each share is has not been measured. Saying "the model did not know
that this happens" on the basis of this chart is allowed only with the caveat
that part of the effect was introduced by the choice of calibrator. A comparison
against Platt scaling on the same windows is the next step, and until then the
wording stays as it is.

### Recovery after retraining is visible too

The model for the 2010 window was trained with 2008–2009 included: ROC-AUC 0.931,
PR-AUC 0.604, ECE 0.010 against 0.028 in the crisis. So the substantive answer to
a regime break is not "the model is bad" but "the model had never seen this and
was bound to be wrong" — and the backtest shows by how much, and how fast it recovers.

---

## 7. Named cases

All five come from the crisis window (test year 2009, model trained through
2009-01-01). They were selected automatically as extremes: the three most
confident hits, the most confident miss and the most confident false alarm. The
moments of evaluation differ — the window covers the whole year, not a single
date.

| outcome     | loan           | state | moment  | currently delinquent | months delinquent over the year | LTV at origination | FICO |  rate | balance | model said |
| ----------- | -------------- | ----- | ------- | -------------------: | ------------------------------: | -----------------: | ---: | ----: | ------: | ---------: |
| hit         | `F06Q10272581` | WV    | 2009-06 |              12 mths |                              12 |                 95 |  634 | 6.50% | 129,628 |     0.7647 |
| hit         | `F06Q10330417` | IN    | 2009-12 |               8 mths |                              12 |                 91 |  684 | 6.38% |  66,015 |     0.7647 |
| hit         | `F01Q30228485` | IA    | 2009-10 |              14 mths |                              12 |                 91 |  622 | 6.88% | 198,910 |     0.7647 |
| **miss**    | `F05Q10174144` | NY    | 2009-07 |               0 mths |                           **0** |                 62 |  695 | 5.00% | 279,077 | **0.0000** |
| false alarm | `F00Q40082360` | IN    | 2009-11 |               4 mths |                              12 |                 70 |  581 | 8.50% |  56,739 |     0.7647 |

The cases were recomputed by the run of 4 August. The hits and the false alarm
are different loans from the July version of the report: every candidate sits at
the calibration ceiling with the same probability, so "the three most confident"
is a choice among equals, and the order within that set changed along with the
sorting fix. **The miss, however, reproduced exactly** — `F05Q10174144`, down to
the last feature and probability. That is no coincidence: `LoanSequenceNumber`
comes from the source, and the analysis below rests on precisely the same data as
three weeks ago.

### The hits: the model found what was there to see

All three had been delinquent for **all twelve** of the last twelve months. Here
the model did not predict the future, it correctly extended an obvious trend. All
three were issued at an LTV of at least 91 — that is, with a down payment below a
tenth of the price.

All three got exactly **0.7647** — the isotonic calibration ceiling described
above. The model cannot say "97%", because such a frequency was never observed in
the pre-crisis window.

### The miss: a loan where everything was fine

**`F05Q10174144`, New York. The model said 0.0000 — and was wrong.**

Look at its features through the model's eyes:

```
months delinquent over the year   0        ← perfect payment discipline
current delinquency status        0        ← at the moment of evaluation as well
time since the last record   1 month       ← no gaps in servicing
mean balance over the year  289,883        ← stable
minimum balance             280,751        ← being repaid
mean rate                     5.00%        ← good, below market
LTV at origination               62        ← conservative, a wide margin
FICO                            695        ← above average
```

**Not one of the seven features raised a flag.** By every behavioural measure
this is a disciplined borrower with moderate debt, and at the moment of
evaluation they were not a single day past due. A year later they were in
default.

**Why the model could not see it.** All its features are aggregates of **the
borrower's own past behaviour**. What changed was not the behaviour but the
outside world: the value of the collateral collapsed, and a loan that had a 38%
equity margin at origination went under water. The borrower did not "turn bad" —
they stopped seeing a reason to pay.

The one feature that could have caught this is `state_eltv_mean_365d`, the mean
estimated LTV by state. In the table it is a dash: the `EstimatedLTV` field does
not exist in the data of that period at all, and the feature is excluded from
training.

**So the miss is explained by exactly the hole that was named in the "caveats"
section before it surfaced.** That is not an excuse for the model but a diagnosis:
to catch cases like this you need a feature describing the state of the
collateral market, and for the crisis period the source has none.

### The false alarm: the same probability as the hits

**`F00Q40082360`, Indiana.** Compare it with the second hit in the table,
`F06Q10330417` — the same state, neighbouring months, comparable debt:

|                                  |    hit | false alarm |
| -------------------------------- | -----: | ----------: |
| months delinquent over the year  |     12 |          12 |
| mean balance over the year       | 66,248 |      61,286 |
| events in the state over 90 days |  9,091 |       9,198 |
| mean rate over the year          | 6.375% |      8.500% |
| FICO at origination              |    684 |         581 |
| model said                       | 0.7647 |      0.7647 |

The identical probability here is not the consequence of identical vectors: the
rate and the FICO differ. But both differing quantities point to **more** risk in
the one that eventually pulled through: a rate two points higher, a FICO a
hundred points lower. So the model erred in the opposite direction to the one the
static features would suggest.

What they did share is the feature that governs ranking: twelve months delinquent
out of twelve. `loan_dlq_months_365d` counts months but does not distinguish
"chronically on the edge but recovering every time" from "sliding down with no
recovery" — the hit's current status is 8 months and the false alarm's is 4, and
that is the only hint of direction, and it never enters the vector.

On top of that lies the calibration ceiling: both sit at 0.7647, and the model
physically cannot separate them by probability even if the input did differ.

This is a concrete, actionable improvement: a direction feature is needed — the
trend of delinquency status, not just a counter.

---

## 8. Portfolio, stress and the check against history

Everything up to this point has been about events: this record has such and such
a probability, the model ranks well, it calibrates badly. The portfolio layer
asks a different question: **how much money is at risk and where it is
concentrated**.

### A position is not an event

The portfolio as of 1 January 2009, position lookback 400 days:

|                                       |           |
| ------------------------------------- | --------: |
| positions                             |   207,867 |
| exposure                              |  $29.83bn |
| expected loss (Σ p × 0.47 × exposure) |   $161.4m |
| share of loss in 1% of positions      | **40.2%** |
| share of loss in the 100 largest      |      4.2% |

The key decision here is what counts as a position. In this domain an event is a
monthly servicing record, and a single loan has up to 360 of them. Adding up the
exposures of all events would count one debt sixty times. So the domain declares
the kind of position: a **stock** — the position is the entity, and the amount at
risk is taken from its latest event. The card domain is the opposite, a **flow**:
a transaction is instantaneous and there is nothing to collapse along an axis.

Forty percent of expected loss in one percent of positions is exactly the answer
to "where is the risk" that a classifier does not have.

**The second decision is what counts as a loss.** Until 6 August expected loss
was computed as `PD × exposure`, that is, on the silent assumption that a default
takes the whole balance. A mortgage has collateral, and that is wrong: across
14,126 dispositions with default codes the realized loss came to 46.9% of the
balance. The formula is now `PD × 0.47 × exposure`, the share is declared by the
domain as a required field, and the number is measured from
`Actual Loss Calculation` — the analysis and the breakdown by year are in the
[domain description](../domains/credit-risk.md). Every money figure below shrank
by exactly a factor of 0.47; **every ratio — the ×3.39 gap, ΔEL in percent, the
slope across deciles, the 40.2% concentration — did not change**, because a
constant multiplier cancels out of them.

### A scenario shocks a field, not a feature

The portfolio as of 2009-01-01, lookback 400 days, scanning 5,303,019 events:

| scenario                                  |   ΔEL | positions affected | events selected | events shocked |  time |
| ----------------------------------------- | ----: | -----------------: | --------------: | -------------: | ----: |
| `high_ltv_rate_shock` (+3 pp on the rate) | +9.6% |             21,999 |         528,614 |        528,614 | 193 s |
| `regional_shock` (LTV ×1.4 in CA/FL/NV)   |     0 |                  0 |         824,213 |          **0** | 184 s |

Computed features cannot be moved individually: several of them are derived from
one field, and shifting them independently produces a vector inconsistent with
itself. What is shocked is an event field, and the recomputation goes through the
same window compiler that builds vectors during training — consistency is
constructive rather than promised.

Delinquency is deliberately not shocked. Its rise is what the model is supposed
to derive itself from more expensive servicing; setting it by hand means planting
the answer in the question and then measuring how well it was planted.

**The extrapolation share is a mandatory line next to ΔEL.** The rate shock
pushes the `loan_rate_mean_365d` feature past the 99th percentile of the training
sample (8.875%) for **7.9% of positions against 0.077% before the shock**. The
model was never trained in that region, and its answer there is not "higher" but
unknown. So +9.6% is not an estimate of losses but an estimate a tenth of which
comes from extrapolation. The percentiles are computed on the training part of
each model version and stored with it (`ModelVersion.quantiles`), so the number
refers to exactly the model the scenario was run against.

**The second row of the table matters more than the first.** Without coverage it
would read as "the portfolio is resilient to a regional collapse". In fact the
shock never reached a single row: the `EstimatedLTV` field does not yet exist in
the source for the crisis window. In terms of ΔEL, "resilient" and "nothing
changed" both give the same zero, and only coverage tells them apart — which is
why such a run is logged as `untouched`, not `completed`.

### The historical run: the model against what actually happened

A scenario answers "the model says this much". It cannot verify that claim — the
hypothetical future never arrived. A historical run answers a different question:
**"the model said this much, and this much came out"**.

| episode                    | model trained up to | predicted | realized |       gap |
| -------------------------- | ------------------: | --------: | -------: | --------: |
| portfolio as of 2009-01-01 |          2009-01-01 |   $161.4m |  $546.4m | **×3.39** |
| portfolio as of 2020-01-01 |          2010-01-01 |    $29.3m |   $61.2m |     ×2.09 |

In counts the gap is smaller: 2,272 expected events against 6,455 actual (×2.84),
and 597 against 987 (×1.65).

**The divergence between money and counts is a separate error.** If the model
had understated the probability alone, the two ratios would agree. They do not:
the losses fell on larger-than-average balances, and the model did not see that
either.

Three things without which this number would be a lie:

1. **The model is chosen by moment, not by "latest".** A January 2009 portfolio
   evaluated by a model that has seen 2010 is a report from the future. The
   version taken is the one with `trainWindowEnd <= t`, and the training boundary
   is printed in the report next to the identifier.
2. **The realization window is not chosen.** It is set by the label horizon — the
   same 365 days the probability was trained for. Allow the window to be passed
   as a parameter, and losses would be counted over a period the probability does
   not predict.
3. **Only positions with both sides are compared.** A feature vector and a
   **matured** label are required. An immature label sits in the table with the
   value `false`, and quietly including it would understate the realized losses.
   How many positions were dropped and why is three separate lines of the report
   (`withoutVector`, `withoutLabel`, `unmatured`); on both episodes all three are
   zero.

The moment of an episode is declared by the domain, not by the request. That is
no small thing: an `at` parameter in the request body would mean the ability to
pick the date on which the model looks respectable.

The second episode is more honestly read as a measurement of staleness than as a
second crisis: the system holds nothing newer than a model trained through 2010,
and it evaluates a 2020 portfolio with decade-old knowledge.

### Exactly where to look when money and counts diverge

×3.39 against ×2.84 is a claim that the model's error is tied to position size.
It is checked directly: the portfolio is split into ten groups of equal position
count by outstanding balance, and in each the predicted is compared with the
actual.

Portfolio as of 2009-01-01, model trained up to 2009-01-01:

| decile | outstanding balance | predicted | actual | actual/predicted |
| -----: | ------------------- | --------: | -----: | ---------------: |
|      1 | 6 – 49,552          |     0.85% |  1.43% |            ×1.68 |
|      2 | 49,553 – 69,296     |     1.11% |  1.80% |            ×1.63 |
|      3 | 69,297 – 87,714     |     1.09% |  2.05% |            ×1.89 |
|      4 | 87,714 – 105,234    |     1.06% |  2.22% |            ×2.09 |
|      5 | 105,234 – 124,464   |     1.06% |  2.69% |            ×2.53 |
|      6 | 124,464 – 146,014   |     1.06% |  3.11% |            ×2.94 |
|      7 | 146,015 – 173,889   |     1.08% |  3.29% |            ×3.05 |
|      8 | 173,893 – 210,713   |     1.19% |  4.12% |            ×3.46 |
|      9 | 210,713 – 269,205   |     1.16% |  4.55% |            ×3.93 |
|     10 | 269,212 – 792,102   |     1.28% |  5.78% |            ×4.53 |

The understatement grows monotonically, from 1.7-fold to 4.5-fold. Within each
decile money and counts agree (×1.66 against ×1.68 in the first, ×4.51 against
×4.53 in the tenth) — balances there are homogeneous. So the aggregate ×1.19 gap
is entirely compositional: it comes from the slope between groups, not from
anything inside them.

**But what matters is not the slope of the actuals, it is its absence in the
model.** The actual frequency grows fourfold, from 1.43% to 5.78%. The predicted
one grows from 0.85% to 1.28%, by half. Position size is barely a signal to the
model, even though in a crisis portfolio it is the strongest signal there is.

**There is nothing to blame the model for, though — until you look at a calm
window.** The same calculation on the 2006 portfolio with a model trained through
2006:

| decile | outstanding balance | predicted | actual | actual/predicted |
| -----: | ------------------- | --------: | -----: | ---------------: |
|      1 | 46 – 50,142         |     0.67% |  0.83% |            ×1.24 |
|      5 | 100,117 – 118,296   |     0.41% |  0.58% |            ×1.44 |
|     10 | 248,442 – 684,975   |     0.07% |  0.19% |            ×2.92 |

**In calm years the relationship runs the other way: large loans defaulted four
times less often.** And the model knew it — it gave them 0.07% against 0.67% for
small ones. The compositional size effect here is ×1.05, which is to say there is
none: $66.7m predicted, $92.3m realized (×1.38), 669 against 879 in counts
(×1.31).

The crisis flipped the sign. By 2009 the model had already started to turn —
2008 was in its training data, and instead of a declining probability it gives a
weakly rising one — but the slope lagged threefold: reality produced a ×4.0
spread across deciles, the model ×1.5.

**What follows from this for the metrics.** ROC-AUC, Brier, log-loss and ECE are
computed over events, without weight. A $50k loan and a $700k loan enter them
identically, so a wrong slope in size is invisible in them in any form: ECE
honestly showed that the probabilities were understated on average, but it cannot
say that they are understated differently depending on balance — not by
construction. That is the substantive argument for a portfolio layer: not "a
prettier display" but measuring what event metrics do not measure.

### The same cut across the backtest windows

The portfolio cut answers "where the model erred at this moment". The same cut
across every backtest test window shows how the error moved over time — and it
reveals what no average metric does.

|                               | decile 1 | decile 4 | decile 7 | decile 10 |
| ----------------------------- | -------: | -------: | -------: | --------: |
| window 2009, actual/predicted |    ×1.26 |    ×1.99 |    ×2.93 |     ×3.74 |
| window 2010, actual/predicted |    ×0.64 |    ×1.04 |    ×1.30 |     ×1.44 |

**At the bottom of the crisis the model understates everywhere**, the more so the
larger the loan. **A year later it has learned the level — and starts to
overstate small loans**, while still understating large ones: the crossing of one
runs through the fourth decile.

Hence the maximum skew falling on the "recovered" window of 2010. ECE takes the
absolute deviation inside a bin of predicted probability, and one such bin holds
both small loans (overstated) and large ones (understated) — inside the bin they
cancel each other, and average calibration looks repaired. Weighting by
outstanding balance removes that cancellation: small loans weigh little, large
ones weigh much, and what is left is pure understatement.

**The metric improved through errors cancelling each other, and a portfolio has
nothing to cancel with.** That is probably the strongest argument that the
portfolio layer is not a display over a classifier but a separate measurement.

Every table in this section is part of the reports (`deciles` in
`POST /history/:id/run` and in the `BacktestRun` record), not a manual analysis:
a cut found once should not need a script to be found again.

### The loss distribution: where in the predicted tail the fact landed

Everything above compared **means**: predicted losses against realized ones. But
a mean does not depend on whether defaults are correlated, while a tail depends
on nothing else. Summing 207,867 independent positions gives σ ≈ $3m — at that
spread the realized $546.4m lies some 130 sigma from the predicted $161.4m,
meaning that an event model assembled into a portfolio without correlation
declares 2009 **impossible** rather than unlikely.

The portfolio layer introduces correlation through the single-factor Vasicek
model: `Aᵢ = √ρ·Z + √(1−ρ)·εᵢ`, default when `Aᵢ < Φ⁻¹(pᵢ)`, one common factor Z
across the portfolio. The loss distribution is computed by Monte Carlo — 50,000
paths, fixed seed 20260807, with the analytic mean travelling next to the
simulated one as a built-in check (they agree to three digits: 161.4 against
161.3). The historical run passes the realized loss to the simulation and gets
back its **exact percentile** — the share of paths that came out better,
computed from the raw scenario array rather than from a histogram.

Correlation ρ is declared by the domain, and it is the least reliable parameter
in the system: my own method-of-moments estimate from annual default rates
(`scripts/correlation.py`) swings from 0.028 to 0.158 depending on the window,
and including a single immature year moves it another fivefold. So the result is
published as a band over three values, each with its origin named — portfolio as
of 2009-01-01, model trained up to 2009-01-01, the `compared` set identical to
the one used for both sides of the comparison of means:

| ρ     | origin                                                             |     σ | VaR99 | VaR99.9 | ES97.5 |  worst | $546.4m → percentile      |
| ----- | ------------------------------------------------------------------ | ----: | ----: | ------: | -----: | -----: | :------------------------ |
| 0.028 | estimated on calm years: what a risk manager would measure in 2008 |  46.7 | 296.0 |   363.5 |  298.3 |  487.3 | **beyond the worst path** |
| 0.105 | estimated over the whole 2000–2025 period, with hindsight          |  94.3 | 482.8 |   710.5 |  493.5 | 1217.6 | 99.48%                    |
| 0.15  | prescribed by Basel IRB for residential mortgages                  | 115.7 | 577.6 |   909.9 |  594.6 | 1708.3 | 98.71%                    |

(money in millions of dollars)

The same measurement on the 2020 episode (17,010 positions, model trained up to
2010-01-01, ρ = 0.15): $29.3m predicted, $61.2m realized — the **97.74th
percentile**, 2.42σ. Both of the model's misses on means turn out to be inside
the predicted tail at the prescribed correlation.

**How to read this.** The three rows of the table are three different claims
about the world:

- At a ρ measured **before** the crisis on calm years, the realized loss occurs
  on none of the 50,000 paths. A portfolio model with an understated correlation
  dies the same way a model with no correlation at all does — only more
  convincingly, because it has a measured parameter.
- At a ρ measured over the whole period — a number knowable only with hindsight —
  2009 sits right at the edge of the support: 0.52% of paths were worse.
- At the Basel-prescribed ρ = 0.15, 2009 is a bad tail with a recurrence of about
  77 years: not an anomaly but an ordinary nightmare that has to be in the
  support.

Hence the conclusion the layer was built for: **the ×3.39 gap on means is fully
covered by systematic risk at the prescribed correlation** — there is no separate
"unexplained" remainder. But the caveat is mandatory: the distribution answers
"if the probabilities are right, how bad can it get", and the backtest showed
they were not right. The 98.71% percentile does not exonerate the event model —
it shows that a portfolio layer with an honest ρ saw the scale of the possible
where the event layer saw nothing.

And this is why Basel prescribes rather than measures: a point-in-time estimate
of ρ behaves worst exactly when it is needed — before a crisis the calm years
drag it down (0.061 → 0.028 by 2008 in this dataset), and a "diversified" portfolio
turns out to be diversified only on the paper of its own measurement. A
prescribed value does not depend on whether a crisis made it into the sample;
that is the entire point of it.

Monte Carlo error at the edge: beyond the 99.9% quantile some 50 outcomes remain
out of 50,000 paths, so VaR99.9 is readable to within a few percent; the
percentiles of the realized loss rest on 260–650 paths and are stable. The number
of paths and ρ travel in every report next to the numbers
(`distribution.scenarios`, `distribution.rho`).

---

## 9. What it would be dishonest to leave out

- **PR-AUC grew from 0.22 to 0.60, and that is not an improvement in the model.**
  The metric depends on the share of positives, and that grew from 0.54% to 6.1%.
  Without the default rate beside them, the crisis windows would look like the
  best in the table.
- **The Kupiec test counts `n` in rows, and rows are not independent.** In the
  2009 test window 2,263,057 records belong to 208,329 loans — 10.86 records per
  loan, and a deeply delinquent loan puts a dozen in a row into the same bin. The
  test is built on independent trials, so it inflates the statistic by roughly
  the same factor. Even with a crude correction, 64,198 → ~5,900 against a
  threshold of 3.84, the conclusion does not change — but printing the raw number
  silently is not acceptable.
- **The metrics in `/train` are optimistically biased.** Brier and log-loss there
  are computed on the calibration slice by the very calibrator fitted on it —
  in-sample. They do not reach the report tables (those evaluate on the test
  window), but they do sit in `ModelVersion.metrics` without saying so.
- **Hyperparameters were not tuned.** 400 iterations, learning rate 0.05, 63
  leaves — the same on all six steps, sensible defaults. No search, no temporal
  validation; overfitting is not controlled by anything.
- **The training window length differs between steps** — from 5 years on the
  first to 11 on the last. Its effect on the metrics is not separated from the
  effect of the crisis.
- **One of the eight declared features takes no part in training.**
  `state_eltv_mean_365d` is computed from the `EstimatedLTV` field, which simply
  does not exist in the early years of the dataset — on the training sample
  before 2008 it is empty across all 10.5M rows. The feature is excluded
  automatically and is **named** in the report of every training run.
- **The consequence is more serious than the feature itself:** the "regional
  market collapse" scenario shocks precisely `EstimatedLTV`. So on the 2008 crisis
  there is nothing to shock, and the scenario layer is not yet applicable to the
  domain's central historical event.
- **The 365-day label maturation horizon is an assumption**, not a fact from the
  data. It was chosen from mortgage risk management practice.
- **A position with a calibrated probability of exactly 0 defaults in no
  simulation path.** Isotonic regression returns exact zeros at the lower edge,
  and such positions contribute nothing to the tail — not even in a state of the
  world where everything falls. The tail of the loss distribution is understated
  by construction by the contribution of those positions.
- **The probabilities here are point-in-time, while the Basel ρ = 0.15 is calibrated
  for through-the-cycle PD.** They already see current delinquency
  through the features, so part of the cycle sits inside them; a common factor on
  top counts part of the cycle a second time. Which way that biases the tail
  depends on the moment: on calm data it overstates, on crisis data it
  understates.
- **The Kupiec test** was proposed as a test of unconditional coverage for VaR.
  Applied to probability bins it reduces to a binomial test of proportion: the
  same machinery, a different purpose. The report calls it that rather than "the industry
  standard for calibration".

---

## 10. How to reproduce

The environment is prepared once — `npm install`, `.env`, the scoring venv,
migrations ([guide](../guide.md), §3). Then:

```bash
./scripts/up.sh                                    # postgres
./scripts/ingest.sh                                # 26.5M events, ~5 min; builds the axis indexes itself
npm run windows -w @mamir/backend -- --plugin credit_risk --what labels
npm run windows -w @mamir/backend -- --plugin credit_risk --what features
npm run dev -w @mamir/scoring &                    # :8001
npm run backtest -w @mamir/backend -- --plugin credit_risk --from 2005-01-01 --steps 6

# baselines on the same windows, from the extracts the backtest already wrote
cd apps/scoring && .venv/bin/python -m app.baseline \
  --work ../backend/data/backtest/credit_risk --steps 6 \
  --out ../../reports/baseline-credit-risk.json
```

The portfolio layer goes over HTTP with the core running
(`npm run dev -w @mamir/backend`):

```bash
curl "localhost:3001/exposure?plugin=credit_risk&at=2009-01-01T00:00:00.000Z&lookback=400d&top=100"

curl -X POST localhost:3001/scenarios/high_ltv_rate_shock/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"credit_risk","at":"2009-01-01T00:00:00.000Z","lookback":"400d"}'

# the moment of a historical episode is set in the domain declaration, not in the body
curl -X POST localhost:3001/history/crisis_2009/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"credit_risk","lookback":"400d"}'

# the same plus the loss distribution and the exact percentile of the realized
# loss (~6 min per value of ρ). The sensitivity band from §8 is three runs: rho
# is optional, and without it the correlation comes from the domain declaration
# (Basel, 0.15)
curl -X POST localhost:3001/history/crisis_2009/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"credit_risk","lookback":"400d","scenarios":50000,"rho":0.028}'
curl -X POST localhost:3001/history/crisis_2009/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"credit_risk","lookback":"400d","scenarios":50000,"rho":0.105}'
curl -X POST localhost:3001/history/crisis_2009/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"credit_risk","lookback":"400d","scenarios":50000}'

# the second episode — a measurement of model staleness (nothing newer than 2010
# exists in the system)
curl -X POST localhost:3001/history/spike_2020/run \
  -H 'content-type: application/json' \
  -d '{"plugin":"credit_risk","lookback":"400d","scenarios":50000}'

# the correlation estimate from the raw servicing files — both columns: with the
# immature first year and without it
apps/scoring/.venv/bin/python scripts/correlation.py
```

The model is seeded and the extraction is fully ordered — repeating a command
gives the same numbers to the last digit, not to four decimal places.

Timings on a MacBook M3 Max (Docker: 10 CPU, 16 GB):

| step                            |   time |
| ------------------------------- | -----: |
| loading 26.5M events            |  287 s |
| labelling (26.5M labels)        |  306 s |
| feature computation (8 × 26.5M) |  638 s |
| backtest, 6 steps               |  770 s |
| baselines, 6 windows × 4        |  815 s |
| portfolio as of 2009-01-01      | ~100 s |
| historical run `crisis_2009`    |   65 s |

The portfolio is more expensive than it looks: 66 of those hundred seconds go on
collecting positions (an index scan over 2.83M events and 248 MB of sorting),
not on scoring.

The timing is unstable, and that is a property of memory rather than of the code.
A measurement on 4 August gave 13.3 s with identical numbers coming out. The
query touches about 8.8 GB of pages (1.13M reads according to
`EXPLAIN (BUFFERS)`) with `shared_buffers` at 4 GB and an event table of 29 GB:
the working set is twice the cache, so a repeat run does not warm it but evicts
it. The table carries what reproduces today.

Checking that features are computed identically in the backtest and in real time:

```bash
npm run windows -w @mamir/backend -- --plugin credit_risk --what verify --sample 400
```

3,200 verified pairs, 0 mismatches. The check itself was validated by breaking
it: changing the window boundary from "strictly earlier" to "earlier or equal"
produces 272 mismatches.
