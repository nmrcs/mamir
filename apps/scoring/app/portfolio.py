"""Portfolio loss distribution: not a single mean, but the whole tail.

Expected loss is the mathematical expectation, and it does NOT depend on
whether position outcomes are linked. Everything else depends on exactly
that: dispersion, quantiles, expected loss beyond a quantile. A portfolio
assembled as a sum of independent positions declares a systemic crisis
impossible — with 208 thousand positions sigma comes out around three
million, while 2009 realized 385 million above the prediction.

The model is the Vasicek single-factor model. A position has a latent
variable

    A_i = √ρ · Z + √(1−ρ) · ε_i,   Z, ε_i ~ N(0, 1) independent,

and default occurs when A_i < Φ⁻¹(PD_i). The common factor Z is one for the
whole portfolio: positions are linked through it, not pairwise. The same
device Aladdin uses with risk factors, in a credit rendition.

WHAT THIS MODEL ANSWERS AND WHAT IT DOES NOT. It says: "IF the
probabilities are correct, how bad can it get". Whether they are correct is
a backtest question, and the two must not be conflated. Declaring a model
miss a tail outcome is passing off an error as bad luck.

The analytic Basel formula (ASRF) does not apply here: it is derived in the
limit of an infinitely granular portfolio, where idiosyncratic risk
averages out to zero, while 40% of our expected loss sits in one percent of
positions. Monte Carlo accounts for concentration by itself, with no
adjustment factor.
"""

import numpy as np
from scipy.stats import norm

# A full "scenarios × positions" matrix on the real portfolio is on the
# order of 10¹⁰ numbers — it does not fit. But given Z the positions are
# independent, so scenarios are computed in chunks: a chunk costs C×N random
# numbers, not all of them at once. Peak memory is three-four C×N matrices
# at a time (the normal's argument, its value, the uniform draws) — half a
# gigabyte at 200 thousand positions.
CHUNK = 100


def simulate(
    probability: np.ndarray,
    exposure: np.ndarray,
    severity: float,
    rho: float,
    scenarios: int,
    seed: int,
    realized: float | None = None,
) -> dict:
    if probability.shape != exposure.shape:
        raise ValueError("probabilities and exposures differ in length")
    if not 0.0 <= rho < 1.0:
        raise ValueError("correlation outside [0, 1)")

    # Position loss when the event occurs. The LGD is the same one used in
    # expected loss: a distribution and its mean cannot have two different
    # definitions of loss.
    loss = (severity * exposure).astype(np.float64)

    # Default threshold in the latent-variable scale. Probabilities 0 and 1
    # do not map through Φ⁻¹, and they do arrive from calibration, where
    # isotonic regression produces exact zeros at the edges.
    safe = np.clip(probability.astype(np.float64), 1e-12, 1 - 1e-12)
    threshold = norm.ppf(safe)

    root_rho = np.sqrt(rho)
    root_rest = np.sqrt(1.0 - rho)
    rng = np.random.default_rng(seed)

    losses = np.empty(scenarios, dtype=np.float64)
    done = 0
    while done < scenarios:
        size = min(CHUNK, scenarios - done)
        # One common factor per scenario — the source of the link between
        # positions.
        factor = rng.standard_normal(size)
        # Conditional default probability given this state of the world.
        conditional = norm.cdf(
            (threshold[None, :] - root_rho * factor[:, None]) / root_rest
        )
        # Comparing against a uniform draw instead of generating ε: same
        # result, half the random numbers.
        draws = rng.random((size, probability.size))
        losses[done : done + size] = (draws < conditional) @ loss
        done += size

    # The analytic mean is computed separately and goes into the report next
    # to the simulated one: the gap between the two numbers is a built-in
    # check that the simulation has not diverged from the expected-loss
    # formula.
    analytic = float((probability * loss).sum())
    counts, edges = np.histogram(losses, bins=50)

    return {
        "expectedLoss": analytic,
        "simulatedMean": float(losses.mean()),
        # Dispersion around the mean. It is exactly zero in the degenerate
        # case "all positions identical and ρ = 1" and maximal under full
        # connectivity.
        "unexpectedLoss": float(losses.std(ddof=1)),
        "var99": float(np.quantile(losses, 0.99)),
        "var999": float(np.quantile(losses, 0.999)),
        # Mean loss in the worst 2.5% of outcomes. Unlike a quantile it
        # answers "how bad is it WHEN it is bad", not "where is the
        # boundary".
        "es975": float(losses[losses >= np.quantile(losses, 0.975)].mean()),
        "max": float(losses.max()),
        "scenarios": scenarios,
        "rho": rho,
        # Where the actually realized loss lands in the predicted
        # distribution — the portfolio model's check against history.
        # Computed here, while the path array is still in memory: on a
        # 50-bin histogram a tail bin tens of millions wide would give a
        # percentile with an error the report never states. Strictly less:
        # the percentile is the fraction of paths that did BETTER, and a
        # path with exactly this loss did not do better.
        "realized": (
            None
            if realized is None
            else {
                "value": realized,
                "percentile": float((losses < realized).mean()),
            }
        ),
        "histogram": {
            "counts": counts.tolist(),
            "edges": edges.tolist(),
        },
    }
