"""Checks of the loss distribution.

The simulation cannot be checked directly against "the right answer" —
there is none. But it has properties that must hold, and each one catches
its own class of bug: the degenerate case is checked against analytics,
monotonicity catches a flipped correlation sign, reproducibility an
unseeded generator.
"""

import unittest

import numpy as np

from app.portfolio import simulate

SCENARIOS = 20_000
SEED = 20260807


class TestIndependentCase(unittest.TestCase):
    """At ρ = 0 the model must reduce to a sum of independent Bernoullis."""

    # A thousand positions, probability 2%, loss 100 each.
    P = np.full(1000, 0.02)
    E = np.full(1000, 100.0)

    def test_mean_matches_the_analytic_one(self):
        result = simulate(self.P, self.E, 1.0, 0.0, SCENARIOS, SEED)
        # 1000 × 0.02 × 100
        self.assertAlmostEqual(result["expectedLoss"], 2000.0, places=9)
        # The simulated mean is within Monte Carlo error.
        error = result["unexpectedLoss"] / np.sqrt(SCENARIOS)
        self.assertLess(abs(result["simulatedMean"] - 2000.0), 4 * error)

    def test_dispersion_matches_the_binomial_sum(self):
        result = simulate(self.P, self.E, 1.0, 0.0, SCENARIOS, SEED)
        # √(Σ Lᵢ² pᵢ(1−pᵢ)) — the analytic sigma of a sum of independent
        # Bernoullis.
        analytic = np.sqrt((self.E**2 * self.P * (1 - self.P)).sum())
        self.assertLess(abs(result["unexpectedLoss"] / analytic - 1.0), 0.05)

    def test_independent_tail_stays_within_a_few_sigmas(self):
        # Exactly this property makes the correlation-free model unfit: by
        # the central limit theorem a sum of independent Bernoullis is
        # nearly normal, and the 99.9% quantile sits about 3.09 sigmas from
        # the mean. The 4σ threshold leaves room for skew and Monte Carlo
        # error.
        #
        # For comparison: what realized in 2009 sat a hundred sigmas from
        # the prediction — under the independent model an event of that
        # scale is not just unlikely, it is outside the distribution's
        # support.
        result = simulate(self.P, self.E, 1.0, 0.0, SCENARIOS, SEED)
        sigma = np.sqrt((self.E**2 * self.P * (1 - self.P)).sum())
        self.assertLess(result["var999"], result["expectedLoss"] + 4 * sigma)
        self.assertGreater(result["var999"], result["expectedLoss"] + 2 * sigma)


class TestCorrelationEffect(unittest.TestCase):
    P = np.full(2000, 0.02)
    E = np.full(2000, 100.0)

    def test_correlation_does_not_move_the_mean(self):
        # The key property: expected loss does NOT depend on connectivity.
        # If the mean moved, conditional and unconditional probability got
        # mixed up.
        for rho in (0.0, 0.15, 0.4):
            result = simulate(self.P, self.E, 1.0, rho, SCENARIOS, SEED)
            self.assertAlmostEqual(result["expectedLoss"], 4000.0, places=9)
            error = result["unexpectedLoss"] / np.sqrt(SCENARIOS)
            self.assertLess(abs(result["simulatedMean"] - 4000.0), 4 * error)

    def test_growing_correlation_fattens_the_tail(self):
        thin = simulate(self.P, self.E, 1.0, 0.0, SCENARIOS, SEED)
        medium = simulate(self.P, self.E, 1.0, 0.15, SCENARIOS, SEED)
        thick = simulate(self.P, self.E, 1.0, 0.4, SCENARIOS, SEED)

        self.assertLess(thin["unexpectedLoss"], medium["unexpectedLoss"])
        self.assertLess(medium["unexpectedLoss"], thick["unexpectedLoss"])
        self.assertLess(thin["var999"], medium["var999"])
        self.assertLess(medium["var999"], thick["var999"])

    def test_quantiles_are_ordered(self):
        result = simulate(self.P, self.E, 1.0, 0.15, SCENARIOS, SEED)
        self.assertLessEqual(result["var99"], result["var999"])
        self.assertLessEqual(result["var999"], result["max"])
        # ES is a mean over a subset of paths, it can never exceed the max.
        self.assertLessEqual(result["es975"], result["max"])


class TestConcentration(unittest.TestCase):
    def test_concentration_fattens_the_tail_at_the_same_mean(self):
        # Two portfolios with identical expected loss: the first has a
        # hundred equal positions, the second one large position and
        # ninety-nine small ones. The means coincide, the tails do not, and
        # that is exactly why the analytic ASRF formula, derived for an
        # infinitely granular portfolio, does not apply here.
        even = simulate(
            np.full(100, 0.05), np.full(100, 100.0), 1.0, 0.15, SCENARIOS, SEED
        )
        lumpy_exposure = np.concatenate(([5050.0], np.full(99, 50.0)))
        lumpy = simulate(
            np.full(100, 0.05), lumpy_exposure, 1.0, 0.15, SCENARIOS, SEED
        )

        self.assertAlmostEqual(even["expectedLoss"], lumpy["expectedLoss"], places=6)
        self.assertGreater(lumpy["unexpectedLoss"], even["unexpectedLoss"])


class TestReproducibility(unittest.TestCase):
    P = np.full(500, 0.03)
    E = np.full(500, 200.0)

    def test_same_seed_gives_same_numbers(self):
        first = simulate(self.P, self.E, 0.5, 0.15, 5_000, SEED)
        second = simulate(self.P, self.E, 0.5, 0.15, 5_000, SEED)
        self.assertEqual(first["unexpectedLoss"], second["unexpectedLoss"])
        self.assertEqual(first["var999"], second["var999"])

    def test_different_seed_gives_different_numbers(self):
        # Otherwise seeding does not work at all and "reproducibility" means
        # nothing.
        first = simulate(self.P, self.E, 0.5, 0.15, 5_000, SEED)
        other = simulate(self.P, self.E, 0.5, 0.15, 5_000, SEED + 1)
        self.assertNotEqual(first["var999"], other["var999"])

    def test_lgd_scales_the_whole_distribution(self):
        full = simulate(self.P, self.E, 1.0, 0.15, 5_000, SEED)
        half = simulate(self.P, self.E, 0.5, 0.15, 5_000, SEED)
        for key in ("expectedLoss", "unexpectedLoss", "var99", "var999", "max"):
            self.assertAlmostEqual(half[key], full[key] * 0.5, places=6)


class TestSinglePosition(unittest.TestCase):
    """A single-position portfolio — the only case where the tail is known exactly.

    Losses are two-point: 0 or severity × exposure. The unconditional
    default probability does NOT depend on ρ — the Vasicek model preserves
    the marginal by construction — and at p > 2.5% every tail quantile
    equals the loss itself. The answer is computed by hand, no "safety
    margin" thresholds.
    """

    RESULT = simulate(
        np.array([0.3]), np.array([1000.0]), 0.5, 0.15, SCENARIOS, SEED
    )

    def test_quantiles_equal_the_position_loss(self):
        # p = 0.3 far exceeds the tail levels, so every tail contains only
        # default paths: the quantiles, ES and max are exactly 500.
        for key in ("var99", "var999", "es975", "max"):
            self.assertEqual(self.RESULT[key], 500.0)

    def test_mean_equals_the_share_of_default_paths(self):
        error = self.RESULT["unexpectedLoss"] / np.sqrt(SCENARIOS)
        self.assertLess(abs(self.RESULT["simulatedMean"] - 150.0), 4 * error)


class TestRealizedPlacement(unittest.TestCase):
    # The percentile of the realized loss on two-point losses is checked by
    # exact equality: the fraction of paths below the midpoint is exactly
    # the fraction of paths without a default, and that is already computed
    # in the mean: mean = fraction × 1000.
    RESULT = simulate(
        np.array([0.3]),
        np.array([2000.0]),
        0.5,
        0.15,
        SCENARIOS,
        SEED,
        realized=500.0,
    )

    def test_percentile_equals_the_share_of_default_free_paths(self):
        survived = 1.0 - self.RESULT["simulatedMean"] / 1000.0
        self.assertAlmostEqual(
            self.RESULT["realized"]["percentile"], survived, places=12
        )
        self.assertEqual(self.RESULT["realized"]["value"], 500.0)

    def test_distribution_edges(self):
        below = simulate(
            np.array([0.3]), np.array([2000.0]), 0.5, 0.15, 2_000, SEED, realized=-1.0
        )
        above = simulate(
            np.array([0.3]), np.array([2000.0]), 0.5, 0.15, 2_000, SEED, realized=1e12
        )
        self.assertEqual(below["realized"]["percentile"], 0.0)
        self.assertEqual(above["realized"]["percentile"], 1.0)

    def test_field_is_empty_without_a_realized_loss(self):
        result = simulate(
            np.array([0.3]), np.array([2000.0]), 0.5, 0.15, 2_000, SEED
        )
        self.assertIsNone(result["realized"])


if __name__ == "__main__":
    unittest.main()
