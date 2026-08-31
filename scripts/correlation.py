#!/usr/bin/env python3
"""Default-correlation estimate from raw Freddie Mac files.

A portfolio is a sum of positions, and how linked their outcomes are
determines not the mean (which does not depend on it at all) but the whole
tail of the loss distribution. The parameter cannot be pulled out of thin
air — for the same reason the LGD could not be: an unverifiable number in a
formula is indistinguishable from a correct one.

The model is the Vasicek single-factor model. A position's latent variable:

    A_i = √ρ · Z + √(1−ρ) · ε_i,   Z, ε_i ~ N(0, 1)

default when A_i < Φ⁻¹(PD). Then the annual default rate

    DR_t = Φ( (Φ⁻¹(PD) − √ρ · Z_t) / √(1−ρ) )

and hence Φ⁻¹(DR_t) is normal with variance ρ/(1−ρ). Method of moments:

    ρ = V / (1 + V),  where V is the sample variance of Φ⁻¹(DR_t)

THE ESTIMATE IS VERY SENSITIVE TO THE WINDOW, and that is the main thing
this script prints. There are a couple dozen annual observations, and the
model assumes a homogeneous pool with constant PD. Our pool is heterogeneous
by age: a loan originated this year physically cannot reach 180+ days
delinquency, so the first year of the data window yields a rate that
measures pool unseasoning, not the regime. In the sample that is 1999 — one
default per 39,641 loans; in the probit scale such a point moves the
variance severalfold.

Hence the first year is excluded by RULE, not by choice: the pool at the
window's start has not seasoned. Both estimates are printed side by side —
with and without the exclusion — so the sensitivity is visible rather than
hidden in a choice of boundaries.

Run: apps/scoring/.venv/bin/python scripts/correlation.py
"""

import glob
import sys
from collections import defaultdict

import numpy as np
from scipy.stats import norm

# Field positions in the servicing files (no headers, `|` delimiter).
LOAN, PERIOD, DLQ, ZERO_BALANCE = 0, 1, 3, 8

# The same loss definition as in the plugin declaration: 180+ days
# delinquency, collateral transfer to the lender, disposition with a credit
# code. They must not diverge — otherwise correlation is measured for one
# event and losses for another.
DEFAULT_CODES = {"02", "03", "09"}


def annual_default_rates(pattern: str) -> dict[int, tuple[int, int]]:
    # Rows are grouped by loan and ordered by period, so a streaming pass
    # suffices: a loan counts as active in a year until its first default,
    # and is counted at most once per year.
    active: dict[int, int] = defaultdict(int)
    defaults: dict[int, int] = defaultdict(int)

    for path in sorted(glob.glob(pattern)):
        with open(path, encoding="utf-8", errors="replace") as handle:
            loan, dead, last_year = None, False, None
            for line in handle:
                row = line.split("|")
                if row[LOAN] != loan:
                    loan, dead, last_year = row[LOAN], False, None
                if dead:
                    continue

                year = int(row[PERIOD][:4])
                if year != last_year:
                    active[year] += 1
                    last_year = year

                status = row[DLQ]
                numeric = int(status) if status.isdigit() else -1
                if numeric >= 6 or status == "RA" or row[ZERO_BALANCE] in DEFAULT_CODES:
                    defaults[year] += 1
                    dead = True

    return {y: (active[y], defaults[y]) for y in sorted(active) if active[y] > 0}


def rho(rates: list[float]) -> float:
    # Degenerate rates (zero or one) do not map through the probit.
    usable = [r for r in rates if 0.0 < r < 1.0]
    if len(usable) < 2:
        return float("nan")
    variance = float(np.var(norm.ppf(usable), ddof=1))
    return variance / (1 + variance)


def main() -> None:
    pattern = (
        sys.argv[1] if len(sys.argv) > 1 else "data/freddie-mac/sample_svcg_*.txt"
    )
    series = annual_default_rates(pattern)
    if not series:
        raise SystemExit(f"no data matching {pattern}")

    print("ANNUAL DEFAULT RATES\n")
    print("year | alive    | defaults | rate")
    for year, (alive, bad) in series.items():
        print(f"{year} | {alive:8d} | {bad:8d} | {bad / alive:.5f}")

    rate = {y: bad / alive for y, (alive, bad) in series.items()}
    all_years = sorted(rate)
    # The first year of the data window is excluded by rule: the pool at the
    # window's start has not seasoned, and its rate measures unseasoning,
    # not the regime.
    seasoned = all_years[1:]
    print(
        f"\nThe pool at the window start has not seasoned — {all_years[0]} is "
        f"excluded from the estimates below ({series[all_years[0]][1]} default(s) "
        f"on {series[all_years[0]][0]} loans)."
    )

    print("\nESTIMATES OF ρ OVER DIFFERENT HISTORY WINDOWS\n")
    print("window          | yrs | ρ (first year dropped) | ρ (all years)")
    windows = [
        ("whole period", seasoned[0], seasoned[-1]),
        ("before crisis", seasoned[0], 2007),
        ("backtest windows", 2005, 2011),
        ("crisis onwards", 2008, 2012),
    ]
    for label, lo, hi in windows:
        kept = [rate[y] for y in seasoned if lo <= y <= hi]
        raw = [rate[y] for y in all_years if lo <= y <= hi or y == all_years[0]]
        print(f"{label:<15} | {len(kept):3d} | {rho(kept):19.4f} | {rho(raw):.4f}")

    print("\nTHE SAME ESTIMATE, POINT-IN-TIME\n")
    print("What a risk manager standing at the start of a year and looking")
    print("only backwards would measure. No number from the future enters")
    print("here, by construction.\n")
    print("as of  | yrs | ρ (first year dropped) | ρ (all years)")
    for cut in seasoned:
        past = [rate[y] for y in seasoned if y < cut]
        raw = [rate[y] for y in all_years if y < cut]
        if len(past) >= 3:
            print(f"{cut}   | {len(past):3d} | {rho(past):19.4f} | {rho(raw):.4f}")

    print("\nBasel IRB prescribes ρ = 0.15 for residential mortgages — it does")
    print("not measure it. The gap between the two columns is the measure of")
    print("how much the estimate can be trusted.")


if __name__ == "__main__":
    main()
