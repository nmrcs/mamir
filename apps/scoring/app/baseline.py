"""Baselines for the report: what the boosting model is compared against.

A metric without a baseline is unreadable. Is ROC-AUC 0.93 a lot or a
little, if sorting by one single feature yields 0.91? Until the table has a
"here is the naive way" row, any model figure is taken on faith.

Baselines are computed under the same protocol as the model: the same
temporal split, the same isotonic calibration on the tail of the training
sample, the same metrics on the same test window. Otherwise it would be
protocols being compared, not models.

Reads the exports the backtest has already placed in `--work` — no need to
rerun the windows and the export. The directory is per-domain: the backtest
lays out exports under `<work>/<pluginId>`, because steps are named
`train-0`, `test-0` and two domains in one directory would collide on those
names.

    .venv/bin/python -m app.baseline \\
        --work ../backend/data/backtest/credit_risk --steps 6 \\
        --out ../../reports/baseline-credit-risk.json
"""

import argparse
import json
import os
import time

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .model import (
    AT,
    EXPOSURE,
    LABEL,
    classifier,
    load_dataset,
    metrics,
    reliability,
    split,
    usable_features,
)


def _feature_ranking(
    fit: pd.DataFrame, features: list[str], fill: pd.Series
) -> list[dict]:
    # The feature is chosen ONLY on the training part. Choosing by the test
    # window would be the same leakage as a random split: the baseline would
    # get an advantage the model does not have.
    #
    # The sign comes from the same place: a feature may separate "the wrong
    # way around", and the baseline must be able to profit from that —
    # otherwise it is artificially understated.
    y = fit[LABEL].astype(int).to_numpy()
    ranking = []
    for name in features:
        auc = roc_auc_score(y, fit[name].fillna(fill[name]).to_numpy())
        ranking.append(
            {
                "feature": name,
                "auc": float(max(auc, 1 - auc)),
                "sign": 1 if auc >= 0.5 else -1,
            }
        )
    return sorted(ranking, key=lambda r: r["auc"], reverse=True)


def _contenders(
    fit: pd.DataFrame, calib: pd.DataFrame, test: pd.DataFrame, features: list[str]
) -> tuple[dict[str, tuple[np.ndarray, np.ndarray]], list[dict]]:
    """Raw scores of every contender on the calibration and test parts."""
    y_fit = fit[LABEL].astype(int).to_numpy()
    # Training-part medians — for both calibration and test. A median
    # computed over the test window would peek at its distribution.
    fill = fit[features].median()

    ranking = _feature_ranking(fit, features, fill)
    best, sign = ranking[0]["feature"], ranking[0]["sign"]

    def column(frame: pd.DataFrame) -> np.ndarray:
        return sign * frame[best].fillna(fill[best]).to_numpy()

    raw = {"single": (column(calib), column(test))}

    # Logistic regression: a linear boundary on the same seven numbers.
    # Unlike histogram gradient boosting it cannot handle missing values
    # natively — hence the median imputation, which is its own limitation,
    # not a handicap granted to it.
    linear = make_pipeline(
        SimpleImputer(strategy="median"),
        StandardScaler(),
        LogisticRegression(max_iter=200),
    )
    linear.fit(fit[features], y_fit)
    raw["logreg"] = (
        linear.predict_proba(calib[features])[:, 1],
        linear.predict_proba(test[features])[:, 1],
    )

    # The production configuration and the same one without class weighting.
    # Weighting systematically inflates raw probabilities, i.e. breaks
    # calibration before isotonic regression starts fixing it; whether the
    # ranking diverges too is a question answered by this pair of rows, not
    # by reasoning.
    for label, weight in (("gbdt", "balanced"), ("gbdt-unweighted", None)):
        model = classifier(weight)
        model.fit(fit[features], y_fit)
        raw[label] = (
            model.predict_proba(calib[features])[:, 1],
            model.predict_proba(test[features])[:, 1],
        )

    return raw, ranking


def _measure(
    raw_calib: np.ndarray,
    y_calib: np.ndarray,
    raw_test: np.ndarray,
    y_test: np.ndarray,
    weight_test: np.ndarray,
    bins: int,
) -> dict:
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(raw_calib, y_calib)
    calibrated = np.clip(calibrator.predict(raw_test), 0.0, 1.0)

    _, ece, ece_weighted = reliability(y_test, calibrated, bins, weight_test)
    return {
        **metrics(y_test, raw_test, calibrated, weight_test),
        "ece": ece,
        "eceWeighted": ece_weighted,
    }


def run(work: str, steps: int, calibration_fraction: float, bins: int) -> list[dict]:
    report = []
    for step in range(steps):
        started = time.monotonic()
        train_frame = load_dataset(os.path.join(work, f"train-{step}.csv"))
        test_frame = load_dataset(os.path.join(work, f"test-{step}.csv"))

        # The feature set is computed by the same function training uses:
        # the baseline must be restricted to exactly the columns the model
        # saw.
        features, _ = usable_features(train_frame)
        fit, calib = split(train_frame, calibration_fraction)
        raw, ranking = _contenders(fit, calib, test_frame, features)

        y_calib = calib[LABEL].astype(int).to_numpy()
        y_test = test_frame[LABEL].astype(int).to_numpy()
        weight_test = test_frame[EXPOSURE].to_numpy()

        entry = {
            "step": step,
            "testFrom": str(test_frame[AT].iloc[0]),
            "testTo": str(test_frame[AT].iloc[-1]),
            "trainRows": int(len(train_frame)),
            "testRows": int(len(test_frame)),
            "features": features,
            "featureRanking": ranking,
            "contenders": {
                name: _measure(
                    raw_calib, y_calib, raw_test, y_test, weight_test, bins
                )
                for name, (raw_calib, raw_test) in raw.items()
            },
            "elapsedMs": round((time.monotonic() - started) * 1000),
        }
        report.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

        del train_frame, test_frame, fit, calib, raw

    return report


def table(report: list[dict]) -> str:
    """Ready-made tables for the report — so the numbers travel by copy-paste."""
    names = list(report[0]["contenders"])
    blocks = []
    for metric in ("rocAuc", "prAuc", "brier", "ece"):
        lines = [
            f"### {metric}",
            "",
            "| window | default rate | " + " | ".join(names) + " |",
            "| --- | ---: | " + " | ".join("---:" for _ in names) + " |",
        ]
        for entry in report:
            cells = " | ".join(f"{entry['contenders'][n][metric]:.4f}" for n in names)
            rate = entry["contenders"][names[0]]["positiveRate"]
            lines.append(f"| {entry['testFrom'][:4]} | {rate:.3%} | {cells} |")
        blocks.append("\n".join(lines))

    chosen = [
        f"{e['testFrom'][:4]}: {e['featureRanking'][0]['feature']} "
        f"(AUC on training {e['featureRanking'][0]['auc']:.4f})"
        for e in report
    ]
    blocks.append("### best single feature by step\n\n" + "\n".join(chosen))
    return "\n\n".join(blocks)


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.baseline")
    parser.add_argument("--work", default="data/backtest")
    parser.add_argument("--steps", type=int, default=6)
    parser.add_argument("--calib", type=float, default=0.2)
    parser.add_argument("--bins", type=int, default=10)
    parser.add_argument("--out", default="reports/baseline.json")
    args = parser.parse_args()

    report = run(args.work, args.steps, args.calib, args.bins)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    print(table(report))


if __name__ == "__main__":
    main()
