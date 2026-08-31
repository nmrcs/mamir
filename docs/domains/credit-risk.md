# Domain: mortgage credit risk

An explanation of the subject area for anyone who has not worked with the US mortgage market. You need it to read the `credit-risk` plugin and understand why the fields are named the way they are.

The source of facts is the official [Single-Family Loan-Level Dataset General User Guide](https://www.freddiemac.com/research/pdf/user_guide.pdf) (January 2026) and the [dataset page](https://freddiemac.com/research/datasets/sf-loanlevel-dataset).

---

## What the risk is

A bank issued someone a mortgage. The person pays every month. The risk is that they stop paying and the lender loses part of the money that was never returned.

Three things set this risk apart from the familiar antifraud case:

- **The loss is not instant.** A borrower does not "turn bad" in a single day: first 30 days past due, then 60, then 90, then foreclosure and sale of the collateral. Months pass between the first missed payment and the recognition of a loss.
- **The size of the loss is not fixed.** Debt is repaid and the balance shrinks. The same loan five years on carries half as much risk in money terms as it did on the day it was issued.
- **Leaving the portfolio is usually not a loss.** Most mortgages end in prepayment: the borrower sold the house or refinanced. The balance went to zero, but nobody lost anything.

That last point is the main trap of the domain, and it will come up again below.

## Where the data comes from

**Freddie Mac** is a US federal mortgage corporation. It buys mortgages from banks and packages them into bonds sold to investors. Since 2008 it has been under the conservatorship of the FHFA.

The data is public not out of goodwill: an investor buying a mortgage-backed security has to be able to assess the probability of defaults. So Freddie Mac is required to disclose anonymized history for every loan. The dataset covers originations **from January 1999**, with monthly servicing history for each loan.

Fannie Mae, the other corporation of the same kind, publishes a similar dataset through its Data Dynamics portal.

## Data structure

For each origination cohort (a quarter, or a year in the sample version) there are **two files**:

| File                | What is inside                            | Granularity                    |
| ------------------- | ----------------------------------------- | ------------------------------ |
| Origination         | loan characteristics at the time of issue | one row per loan               |
| Monthly Performance | how the loan was serviced                 | **one row per loan per month** |

They are joined by `Loan Sequence Number`. The files carry no headers — columns are identified by position, and the order is described in the User Guide.

### An event in this domain is not an application, it is a month in the life of a loan ★

The key point, and the reason this domain was chosen.

In card fraud an event is atomic: a transaction happened, the outcome is known almost immediately, and the event maps one-to-one onto an entity. Here it is different: **an event is a monthly servicing record**, and a single loan has dozens or hundreds of them, stretched over years. A 30-year mortgage produces up to 360 events.

Hence `entityKeys.loan` is the `Loan Sequence Number`, and a long ordered history accumulates against a single entity. That is exactly the configuration the platform has to digest, and the one the card domain never exercised.

### The fields used

From **Origination** — characteristics at the time of issue, they do not change:

| Field                       | Meaning                                | Values                          |
| --------------------------- | -------------------------------------- | ------------------------------- |
| `Credit Score`              | the borrower's credit score            | 300–850, `9999` = not available |
| `First Payment Date`        | date of the first payment              | `YYYYMM`                        |
| `Original UPB`              | loan amount at origination             | dollars                         |
| `Original LTV`              | loan relative to the value of the home | percent                         |
| `Original DTI`              | payment relative to income             | percent                         |
| `Original Interest Rate`    | the rate                               | percent                         |
| `Property State`            | state                                  | two-letter code                 |
| `First Time Homebuyer Flag` | first home                             | `Y` / `N` / `9`                 |

From **Monthly Performance** — these change every month:

| Field                                | Meaning                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `Monthly Reporting Period`           | the reporting month, `YYYYMM` — **this is the event timestamp** |
| `Current Actual UPB`                 | the current outstanding balance — **this is the exposure**      |
| `Current Loan Delinquency Status`    | delinquency stage                                               |
| `Loan Age`                           | how many scheduled payments have passed since origination       |
| `Remaining Months to Legal Maturity` | how many months remain until the end of the term                |
| `Zero Balance Code`                  | why the balance went to zero, if it did                         |
| `Zero Balance Effective Date`        | when that happened                                              |
| `Current Interest Rate`              | the current rate (it may have changed on a modification)        |
| `DDLPI`                              | date of the last instalment actually paid                       |

### Delinquency stages

`Current Loan Delinquency Status` follows the Mortgage Bankers Association (MBA) method:

```
0   current, or less than 30 days past due
1   30–59 days
2   60–89 days
3   90–119 days
…   onwards on the same logic
RA  collateral taken over by the lender (REO Acquisition)
```

### Reasons a balance goes to zero

`Zero Balance Code` — why the loan left the portfolio:

```
01  prepayment or end of term                  ← NOT a loss
02  third-party sale                            ← a loss
03  short sale or charge-off                    ← a loss
09  REO disposition                             ← a loss
15  whole loan sale                             ← NOT a loss, a technical exit
16  securitization of reperforming loans        ← NOT a loss
96  defect ahead of another termination event   ← technical
```

## What counts as a loss

**This is a decision, not something given in the data.** There is no ready-made "default" column; the definition is chosen, and the report has to name it explicitly.

The label follows the industry standard: a loss is either delinquency that reached 180 days, or collateral passing to the lender (status `RA` — REO Acquisition), or the loan leaving with code `02`, `03` or `09`. Exactly that set is declared in the plugin (`label.anyOf`) — the definition here and the definition in code have to match word for word, otherwise the run measures something other than what the report describes.

**What must not be done** is the trap itself: treating any zeroing of the balance as an event. Code `01` (prepayment) is the most common outcome of a mortgage and is not a loss at all. A model trained on that labelling learns not default risk but the propensity to refinance — a quantity that behaves the opposite way: it is precisely the reliable borrowers who prepay when rates fall.

Formally these are two competing risks: a loan may default or it may prepay, and the second rules out the first. Only the first is modeled, and the second is treated as censoring: the loan is gone, and no outcome will arrive for it.

## Exposure

`Current Actual UPB` — the outstanding balance in the reporting month.

This differs fundamentally from the card domain, where exposure was the transaction amount — a fixed number known at the moment of the event. Here exposure **shrinks over time** on the same entity: the loan is being repaid. Portfolio expected loss therefore moves even when default probabilities do not.

### Loss given default: a default does not take the whole balance

The amount at risk is not the same as the amount lost. A mortgage has collateral: on default the house is sold, part of the debt is covered by the proceeds, and the rest is written off. The industry formula for expected loss is `EL = PD × LGD × EAD`, where **LGD** (loss given default) is the share that could not be recovered.

I **measured it rather than assumed it**. The servicing files carry `Actual Loss Calculation` (the realized loss on a loan that left the portfolio, net of sale proceeds, insurance recoveries and collection expenses) and `Zero Balance Removal UPB` (the balance at the time of removal). Across 14,126 dispositions with default codes `02`/`03`/`09` in the 1999–2007 cohorts:

```
sum(Actual Loss) / sum(Zero Balance Removal UPB) = 1,021,010,552 / 2,176,783,154 = 0.469
```

**Individual loans exceed 100%** — the realized loss covers not only the principal but also collection costs, taxes and upkeep of the house until it sells. The very first disposition in the sample: 71,677 of loss on 60,182 of balance. The aggregate share is below one precisely because collateral covers more than half on average.

**The number depends heavily on the regime** — and that, rather than the number itself, is what matters here:

| Disposition year | Dispositions | LGD  |
| ---------------- | ------------ | ---- |
| 2000             | 4            | 0.01 |
| 2003             | 219          | 0.11 |
| 2005             | 271          | 0.22 |
| 2007             | 238          | 0.20 |
| 2008             | 421          | 0.33 |
| 2009             | 1,013        | 0.41 |
| 2011             | 2,257        | 0.51 |
| 2016             | 491          | 0.61 |
| 2020             | 71           | 0.53 |

While house prices were rising, the collateral covered almost the whole debt — in 2000 the loss was a little over one percent. After prices collapsed, the same procedure recovered only half. In other words **the crisis hit twice**: both the probability of default and the loss given default went up.

**Why the declaration still carries a constant.** The temptation to plug in the LGD of the year a calculation refers to has to be called what it is: **a number from the future**. On 1 January 2009 nobody knew that 2011 dispositions would come to 51% — those loans had not even defaulted yet. A time-varying share would need its own point-in-time treatment, exactly like a feature: "what was known as of time t". I do not build such a mechanism, so the declaration carries the constant `severity: 0.47` — the average across the whole period computed with hindsight — and the assumption is named here, in the plugin declaration and in the report.

**What this correction does not change.** Ratios. The gap between predicted and realized (×3.39 in the historical scenario), scenario-stress ΔEL in percent, the slope across deciles, the "40% of losses in 1% of positions" concentration — a constant multiplier cancels out of all of them. Only the absolute amounts change, and they change in the right direction: previously they meant "a default takes the whole balance", which never happens.

## Label maturation

The domain was chosen partly for this. The maturation horizon here is not an assumption but a property of the data: the path from the first missed payment to a recognized loss takes months, and every step is visible in the monthly history.

As of time `t` only what was recorded in reports **before** `t` is known. A loan that is in status `2` today (60–89 days) may be in default six months from now, or back to current. Training on its final outcome while standing at time `t` is leakage.

## Mapping onto the plugin contract

| Contract           | Data field                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- |
| `event`            | Origination joined to Monthly Performance on `Loan Sequence Number`                 |
| `entityKeys.loan`  | `Loan Sequence Number`                                                              |
| `entityKeys.state` | `Property State` — the cohort axis for scenarios                                    |
| `occurredAt`       | `Monthly Reporting Period`                                                          |
| `exposure`         | `Current Actual UPB`, LGD 0.47 — measured from `Actual Loss Calculation`            |
| `label`            | derived from `Current Loan Delinquency Status` and `Zero Balance Code`              |
| `features`         | delinquency dynamics, loan age, share repaid, deviation of the rate from the market |

## What the 2007 cohort showed

The sample files `sample_orig_2007.txt` and `sample_svcg_2007.txt`:

```
50,000 loans, 3,003,932 monthly records
history span: 200612 — 202509 (almost 19 years)

reasons for leaving the portfolio:
  01  prepayment                  42,500   ← 85% of all loans
  09  REO disposition              2,524
  03  short sale / charge-off      1,197
  02  third-party sale               538
  16  RPL securitization           1,127
  15  whole loan sale                220
  96  defect                         516

default by removal code (02/03/09):   4,259   8.52%
reached 180+ days delinquent:         6,732  13.46%
total defaults (the union):           6,867  13.73%
```

The prepayment trap was confirmed numerically: labelling on "the balance went to zero" would have produced **92%** positives instead of 13.73%.

Delinquency statuses in the data are integers from `0` to `156` plus `RA`. Column positions were determined from the contents of the files rather than from the PDF guide: extracting them from it confuses the position number with the field length.

## What this domain changed in the contract

Three places where the contract did not express what was needed. The first two surfaced while reading documentation, the third on real data — and that one turned out to be the important one.

**1. `TimeSpec` did not know the `YYYYMM` format.** A reporting period is `200704`, neither an ISO string nor a number of seconds. The `yyyymm` unit was added: balance-sheet domains have monthly granularity, and the data has no day at all.

**2. The loss definition could not be expressed as an equality.** It used to be "field equals value". Here a disjunction of heterogeneous conditions is needed: delinquency ≥ 180 days, or `RA`, or a removal code from a set. `LabelSpec.anyOf` is now disjunctive normal form — OR between groups, AND within a group.

**3. The label does not live in the event at all. ★** An event is a loan-month, while the outcome arrives in later records of the same loan, months away. The contract, though, assumed the label was a payload field.

Hence a decision that actually simplified the contract: **a label is a feature that looks forward.** The same window machinery as `FeatureSpec`, only with the sign of time reversed:

```ts
label: {
  scope: 'forward',        // the outcome lives in later events of the entity
  entity: 'loan',
  horizon: '365d',         // once the window closes, the label is known
  anyOf: [ … ],
}
```

This has a property built into it: using the label at scoring time is impossible by construction — at time `t` the future does not exist yet. The maturation horizon stops being a separate mechanism and becomes just the size of a window.

For the card domain, where the outcome is recorded in the event itself, there is `scope: 'self'` — there the horizon means only the delay before confirmation.

The second domain started testing the boundary before it was written, and the result was not a more complex contract but two mechanisms merged into one.

## Caveats

- **Time granularity is a month.** Windows like `24h` are meaningless in this domain; `90d` and `365d` work. The `FeatureSpec.window` syntax handles both.
- **The full dataset is enormous** — billions of monthly records. This project uses the sample version: on the order of 50 thousand loans per origination year.
- **License.** Use is for your own analysis; redistribution of the raw data is prohibited. The repository holds no data — everyone downloads it under their own account. The repository publishes only derivatives: metrics, curves, case walkthroughs.
- **The data is not about everyone.** The dataset contains only loans that met Freddie Mac's purchase requirements. The subprime segment that brought the market down in 2008 is largely absent — which means the calibration failure during the crisis will be milder here than it was in the market as a whole. That has to be said in the report, not quietly passed off as a picture of the market.
