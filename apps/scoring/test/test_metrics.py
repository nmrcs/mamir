"""Checks of the numbers the service emits.

The core's tests check the INPUTS to the numbers — the contract, the
window SQL, the byte-for-byte reproducibility of the export. This file
checks the numbers themselves.

Every test here rests on an answer computed by hand or known analytically.
Checking the implementation against itself would be pointless.
"""

import math
import unittest

import numpy as np

from app.model import _kupiec, exposure_deciles, metrics, reliability


class TestMetrics(unittest.TestCase):
    def test_brier_is_mean_squared_error(self):
        y = np.array([0, 1, 1, 0])
        p = np.array([0.1, 0.9, 0.6, 0.2])
        # (0.01 + 0.01 + 0.16 + 0.04) / 4
        self.assertAlmostEqual(
            metrics(y, p, p, np.ones(4))["brier"], 0.055, places=12
        )

    def test_weighted_brier_weights_by_exposure(self):
        y = np.array([0, 1, 1, 0])
        p = np.array([0.1, 0.9, 0.6, 0.2])
        w = np.array([1.0, 1.0, 2.0, 6.0])
        # (0.01·1 + 0.01·1 + 0.16·2 + 0.04·6) / 10
        result = metrics(y, p, p, w)
        self.assertAlmostEqual(result["brierWeighted"], 0.058, places=12)
        # And it MUST differ from the plain one, otherwise the weight is not
        # being applied.
        self.assertNotAlmostEqual(result["brierWeighted"], result["brier"])

    def test_log_loss_on_a_single_event(self):
        y = np.array([1, 1])
        p = np.array([0.5, 0.5])
        self.assertAlmostEqual(
            metrics(y, p, p, np.ones(2))["logLoss"], -math.log(0.5), places=12
        )

    def test_roc_auc_on_known_edge_cases(self):
        y = np.array([0, 0, 1, 1])
        perfect = np.array([0.1, 0.2, 0.8, 0.9])
        reversed_ = np.array([0.9, 0.8, 0.2, 0.1])
        w = np.ones(4)

        self.assertAlmostEqual(metrics(y, perfect, perfect, w)["rocAuc"], 1.0)
        self.assertAlmostEqual(metrics(y, reversed_, reversed_, w)["rocAuc"], 0.0)
        # A constant score does not discriminate at all — exactly 0.5, not
        # "around".
        constant = np.full(4, 0.3)
        self.assertAlmostEqual(metrics(y, constant, constant, w)["rocAuc"], 0.5)

    def test_pr_auc_of_a_constant_model_equals_base_rate(self):
        # The property the second-domain null-hypothesis check rests on:
        # without lift, PR-AUC must coincide with the positive rate.
        y = np.array([0, 0, 0, 1])
        constant = np.full(4, 0.3)
        result = metrics(y, constant, constant, np.ones(4))
        self.assertAlmostEqual(result["prAuc"], 0.25, places=12)
        self.assertAlmostEqual(result["positiveRate"], 0.25, places=12)

    def test_rank_metrics_are_nan_on_a_single_class_window(self):
        # ROC-AUC and PR-AUC are undefined on a single-class sample. The
        # service returns NaN — and that is DECLARED behavior, not an
        # accident: the frontend types the field as a number and NaN must
        # not reach it. The test pins the contract so a change is visible.
        y = np.zeros(4)
        p = np.array([0.1, 0.2, 0.3, 0.4])
        result = metrics(y, p, p, np.ones(4))
        self.assertTrue(math.isnan(result["rocAuc"]))
        self.assertTrue(math.isnan(result["prAuc"]))
        # Brier is still computed: it is defined on a single class.
        self.assertFalse(math.isnan(result["brier"]))


class TestReliability(unittest.TestCase):
    # Two bins, error 0.1 in the lower one and 0.4 in the upper one.
    Y = np.array([0, 0, 1, 0])
    P = np.array([0.1, 0.1, 0.9, 0.9])

    def test_curve_and_ece_use_probability_bins(self):
        curve, ece, _ = reliability(self.Y, self.P, 2, np.ones(4))

        self.assertEqual([b["bin"] for b in curve], [0, 1])
        self.assertEqual([b["count"] for b in curve], [2, 2])
        self.assertAlmostEqual(curve[0]["predicted"], 0.1)
        self.assertAlmostEqual(curve[0]["observed"], 0.0)
        self.assertAlmostEqual(curve[1]["predicted"], 0.9)
        self.assertAlmostEqual(curve[1]["observed"], 0.5)
        # 0.5·|0.1−0| + 0.5·|0.9−0.5|
        self.assertAlmostEqual(ece, 0.25, places=12)

    def test_empty_bins_are_left_out_of_the_curve(self):
        curve, _, _ = reliability(self.Y, self.P, 10, np.ones(4))
        self.assertEqual([b["bin"] for b in curve], [1, 9])

    def test_weighted_ece_grows_when_money_sits_in_a_poorly_calibrated_bin(self):
        # The project's claim "a skew above one means the error moved onto
        # large positions" is verified here, not only on live data.
        _, ece, heavy_top = reliability(
            self.Y, self.P, 2, np.array([1.0, 1.0, 10.0, 10.0])
        )
        _, _, heavy_bottom = reliability(
            self.Y, self.P, 2, np.array([10.0, 10.0, 1.0, 1.0])
        )

        # (2/22)·0.1 + (20/22)·0.4
        self.assertAlmostEqual(heavy_top, 0.1 * 2 / 22 + 0.4 * 20 / 22, places=12)
        self.assertGreater(heavy_top, ece)
        self.assertLess(heavy_bottom, ece)

    def test_zero_weight_bin_contributes_nothing_to_weighted_ece(self):
        # Not a made-up case: a mortgage balance drops to zero in the month
        # the loan closes, and such a bin contributes nothing to the money
        # total — but it must not vanish from the curve.
        curve, _, weighted = reliability(
            self.Y, self.P, 2, np.array([0.0, 0.0, 1.0, 1.0])
        )
        self.assertEqual(len(curve), 2)
        self.assertAlmostEqual(weighted, 0.4, places=12)


class TestKupiec(unittest.TestCase):
    def test_statistic_is_zero_when_observed_matches_stated(self):
        self.assertAlmostEqual(_kupiec(10, 3, 0.3), 0.0, places=12)

    def test_clear_divergence_crosses_the_five_percent_boundary(self):
        # 5% promised, 30% observed over a hundred events.
        self.assertGreater(_kupiec(100, 30, 0.05), 3.84)

    def test_degenerate_observed_proportion_yields_a_finite_number(self):
        # No breaches at a stated 30%: the log of zero is sidestepped, but
        # the result must remain a number and exceed the boundary.
        value = _kupiec(10, 0, 0.3)
        self.assertTrue(math.isfinite(value))
        self.assertAlmostEqual(value, -2 * 10 * math.log(0.7), places=12)
        self.assertGreater(value, 3.84)

    def test_undefined_inputs_yield_nan(self):
        for n, hits, expected in ((0, 0, 0.3), (10, 3, 0.0), (10, 3, 1.0)):
            self.assertTrue(math.isnan(_kupiec(n, hits, expected)))


class TestDeciles(unittest.TestCase):
    # Twenty positions with exposures 1…20 — two per decile.
    Y = np.array([0, 1] * 10)
    P = np.full(20, 0.1)
    W = np.arange(1.0, 21.0)

    def test_groups_are_equal_by_count_and_ordered_by_exposure(self):
        rows = exposure_deciles(self.Y, self.P, self.W, 1.0)

        self.assertEqual(len(rows), 10)
        self.assertEqual([r["count"] for r in rows], [2] * 10)
        self.assertEqual([r["from"] for r in rows], list(range(1, 21, 2)))
        self.assertEqual([r["to"] for r in rows], list(range(2, 21, 2)))
        self.assertEqual([r["exposure"] for r in rows], [3, 7, 11, 15, 19, 23, 27, 31, 35, 39])

    def test_lgd_scales_money_and_leaves_frequencies_alone(self):
        # LGD enters the sums and does not enter the frequencies.
        full = exposure_deciles(self.Y, self.P, self.W, 1.0)
        half = exposure_deciles(self.Y, self.P, self.W, 0.5)

        for a, b in zip(full, half):
            self.assertAlmostEqual(b["predictedLoss"], a["predictedLoss"] * 0.5)
            self.assertAlmostEqual(b["realizedLoss"], a["realizedLoss"] * 0.5)
            self.assertEqual(b["predicted"], a["predicted"])
            self.assertEqual(b["observed"], a["observed"])
            self.assertEqual(b["exposure"], a["exposure"])

    def test_losses_are_sum_of_probability_times_exposure_times_lgd(self):
        rows = exposure_deciles(self.Y, self.P, self.W, 0.5)
        # First decile: exposures 1 and 2, probability 0.1, LGD 0.5.
        self.assertAlmostEqual(rows[0]["predictedLoss"], 0.1 * 3 * 0.5, places=12)
        # Realized only on the second position (label 1) with exposure 2.
        self.assertAlmostEqual(rows[0]["realizedLoss"], 2 * 0.5, places=12)

    def test_no_cut_when_the_sample_is_smaller_than_the_group_count(self):
        # Five positions over ten groups — dividing would yield empty
        # groups, and their observed frequency would be noise, not a
        # measurement.
        self.assertEqual(
            exposure_deciles(np.zeros(5), np.full(5, 0.1), np.ones(5), 1.0), []
        )


if __name__ == "__main__":
    unittest.main()
