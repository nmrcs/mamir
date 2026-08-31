# Domain: payment fraud

An explanation of the `payment-fraud` domain for anyone reading its plugin. It was plugged in second and does two jobs: it proves the core is domain-agnostic, and it acts as a null hypothesis — a domain where the right answer to every measurement is known in advance.

The shape of the data comes from [IEEE-CIS Fraud Detection](https://www.kaggle.com/competitions/ieee-fraud-detection), a Kaggle competition on real Vesta transactions.

---

## What the risk is

One-sided and instant: a transaction is either fraud or not, and the outcome is recorded in the event itself. That makes the domain the opposite of the credit one, where risk matures over months and the outcome arrives in later records of the same loan. The pair was chosen deliberately — the plugin contract has to express both regimes without changing.

## Where the data comes from

**The real competition data is not in the repository:** Kaggle rules forbid redistribution, and downloading it under your own account is not needed for a second domain. In its place is a [generator](../../scripts/synthetic-csv.mjs) that reproduces the shape of the dataset:

```bash
node scripts/synthetic-csv.mjs --rows 590000 --out data/synthetic.csv
```

590,000 transactions, 370+ columns, the same sparsity, the same relative time scale. The generator is seeded (`--seed 42`), so runs are comparable with each other.

**The label is derived from a hash of the transaction id, independently of every feature.** Hence the main property of the domain: the right answer is known before the measurement. ROC-AUC has to be 0.5, PR-AUC has to equal the positive rate, and realized losses have to land in the body of the distribution. Any lift over chance means leakage in the engine, not a good model.

### The generator trap that cost a false result

The first version used ordinary multiplication in a linear congruential PRNG. `2^31 × 1103515245` exceeds `2^53`, a double loses precision, the recurrence degenerates and the period collapses to 10,466 values. Over 590,000 rows that is a repeating pattern with a stride of about 28 rows: the model memorizes the cycle and produces **ROC-AUC 1.0 on a label that is independent of every feature by construction**. The fix is `Math.imul`. The null hypothesis caught itself — exactly the work the domain exists for.

## Data structure

A transaction is a single event; there are four entities to aggregate over, all taken from payment fields:

| Axis     | Field           | What it means                    |
| -------- | --------------- | -------------------------------- |
| `card`   | `card1`         | the card                         |
| `addr`   | `addr1`         | the payer's address              |
| `email`  | `P_emaildomain` | the email domain                 |
| `device` | `DeviceInfo`    | the device the payment came from |

Only the fields the platform needs are declared in `event`: axis, timestamp, exposure, label and feature sources. The dataset has 430+ of them (`C1..C14`, `D1..D15`, `M1..M9`, `V1..V339`) — the rest arrive in the payload as they are and get stored, but the platform does not use them.

### Time here is relative

`TransactionDT` is **not a date, but seconds from an unknown origin**. The calendar dates floating around write-ups of this dataset are a community reconstruction and are not used in this project. Point-in-time needs only monotonicity, so every window in the domain is computed in relative time, and chart axes are labelled the same way.

## What counts as a loss

The `isFraud` field on the event itself, `scope: 'self'` — there is no need to look for the outcome in later records.

**The 30-day maturation horizon is an assumption.** Labelling in IEEE-CIS is final and the data carries no confirmation timestamp; 30 days is taken from chargeback practice. This is exactly the case where an assumption is stated out loud instead of hidden: the horizon decides which backtest windows exist at all. That is why the domain's last window is empty — the data ends on 29 June, and not one June transaction has a confirmed label.

## Exposure

`TransactionAmt`, and the position is a **flow**: the exposure is the event itself, not the latest state of an entity. The credit domain is the other way round — there a position is a stock, a loan with an outstanding balance. The domain declares the difference; the core knows nothing about it.

**Loss given default is 1.** There is no collateral here and nothing to recover: a fraudulent transaction is lost in full. In a real payment domain a chargeback would return part of it, but the data is synthetic and contains no recoveries by construction. The multiplier is declared explicitly, as the contract requires: a required field with no default, otherwise "LGD = 1" would become an invisible assumption.

**Correlation is 0,** and that is measured rather than assumed: the label is generated independently and there is no common factor by construction. The portfolio has to add up as a sum of independent events, which also gives a degenerate case for validating the simulation — at ρ = 0 it reduces to a binomial sum. In a real payment domain zero would be wrong: a coordinated attack is precisely a common factor.

## Mapping onto the plugin contract

Nine features, all of them window declarations, not one function:

| Feature                 | Axis   | Aggregate    | Window | Why                             |
| ----------------------- | ------ | ------------ | ------ | ------------------------------- |
| `card_txn_count_24h`    | card   | `count`      | 24h    | velocity: a burst of attempts   |
| `card_amt_sum_24h`      | card   | `sum`        | 24h    | total volume over a day         |
| `card_amt_mean_7d`      | card   | `mean`       | 7d     | the usual amount for this card  |
| `card_amt_std_7d`       | card   | `std`        | 7d     | spread of amounts               |
| `card_time_since_prev`  | card   | `time_since` | 30d    | the pause before a transaction  |
| `card_distinct_addr_7d` | card   | `distinct`   | 7d     | a card roaming across addresses |
| `addr_txn_count_7d`     | addr   | `count`      | 7d     | load on an address              |
| `email_txn_count_7d`    | email  | `count`      | 7d     | load on an email domain         |
| `device_txn_count_24h`  | device | `count`      | 24h    | load on a device                |

There is one substantive scenario — `amount_spike`, a hijacked card: amounts ×3 at the same frequency. A field shock can say nothing about the volume of an attack: "eight times more transactions" means generating events, while a shock changes values in existing ones.

There is one historical episode as well — `control_month`, the portfolio as of 1970-06-01 on the relative scale. The credit domain checks that the portfolio layer sees a crisis; this one checks that it does not invent a crisis where there is none.

## Caveats

- **Calibration is not measured on this domain.** The label is random; what the model can do on the real IEEE-CIS is unknown and not claimed. Calibration is measured on the credit domain, where there are 26.5M real events.
- **The generator reproduces the shape, not the data.** There is no join with `train_identity.csv` (in the synthetic data every column is in one file) and no correlations between features.
- **There is no ingestion delay in the data.** On load, `ingestedAt = occurredAt`; the contract distinguishes late-arriving events, but the project has no data with a real delay yet.

The domain's numbers and what they showed are in the [results](../results/payment-fraud.md).
