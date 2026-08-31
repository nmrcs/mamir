import os
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)

MODELS_DIR = os.environ.get("MODELS_DIR", "models")

# Service columns of the export. Everything else in it is a feature: the set
# is defined by the plugin, and listing it here would pull the domain into
# the service.
ID = "eventId"
AT = "at"
LABEL = "label"
EXPOSURE = "exposure"


def load_dataset(dataset: str) -> pd.DataFrame:
    # CSV only: Postgres has native COPY with no new dependencies, and there
    # is no maintained parquet writer for Node — a second format would be a
    # branch nobody executes.
    #
    # The file is a system boundary, so it is validated here. Further down
    # the code trusts the contract.
    frame = pd.read_csv(dataset, parse_dates=[AT])

    missing = {ID, AT, LABEL, EXPOSURE} - set(frame.columns)
    if missing:
        raise ValueError(f"columns missing from the extract: {sorted(missing)}")
    if frame.empty:
        raise ValueError("the extract is empty")
    return frame.sort_values(AT, kind="stable")


def metrics(
    y: np.ndarray, raw: np.ndarray, calibrated: np.ndarray, weight: np.ndarray
) -> dict:
    # ROC-AUC and PR-AUC are invariant under monotonic calibration, so they
    # are computed on the raw score. Brier and log-loss on the calibrated
    # one: they measure exactly what calibration changes.
    #
    # PR-AUC is mandatory next to ROC-AUC: at a ~3% positive rate ROC-AUC
    # flatters, because negatives outnumber positives by an order of
    # magnitude.
    #
    # The weighted Brier sits next to the plain one because the plain one is
    # by construction blind to whether the error correlates with position
    # size: a 50k loan enters it the same way a 700 one does. The gap
    # between the two numbers is the answer to "does the model err where it
    # costs more".
    single_class = len(np.unique(y)) < 2
    return {
        "brier": float(brier_score_loss(y, calibrated)),
        "brierWeighted": float(np.average((y - calibrated) ** 2, weights=weight)),
        "logLoss": float(log_loss(y, calibrated, labels=[0, 1])),
        "rocAuc": float("nan") if single_class else float(roc_auc_score(y, raw)),
        "prAuc": (
            float("nan") if single_class else float(average_precision_score(y, raw))
        ),
        "positiveRate": float(y.mean()),
    }


def usable_features(frame: pd.DataFrame) -> tuple[list[str], list[str]]:
    # A feature declared by the plugin may be undefined in a given window:
    # the field appeared in the source later. Freddie Mac has no EstimatedLTV
    # in the early years, so state_eltv_mean_365d is entirely empty on the
    # pre-2008 sample — all 10.5M rows.
    #
    # Such a column can neither be trained on (the binner crashes on an
    # all-NaN array) nor silently kept: the model's feature set would drift
    # from the domain declaration and nobody would know. We exclude it and
    # say so out loud — the exclusions go into the report next to the
    # metrics.
    declared = [c for c in frame.columns if c not in (ID, AT, LABEL, EXPOSURE)]
    features = [c for c in declared if frame[c].notna().any()]
    if not features:
        raise ValueError("the sample has no populated feature at all")
    return features, [c for c in declared if c not in features]


def split(frame: pd.DataFrame, fraction: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    # Split by time, not at random. A random split on temporal data yields
    # calibration fitted to the future: rows of the same loan land in both
    # the training and the calibration parts.
    cut = int(len(frame) * (1 - fraction))
    fit_part, calib_part = frame.iloc[:cut], frame.iloc[cut:]
    if fit_part.empty or calib_part.empty:
        raise ValueError("the temporal split produced an empty part — the sample is too small")
    return fit_part, calib_part


def classifier(class_weight: str | None = "balanced") -> HistGradientBoostingClassifier:
    # One configuration for all readers: training and the baseline
    # measurement (`app.baseline`) must compare the exact same model, or the
    # numbers in the report would silently diverge. `class_weight` is the
    # only parameter that changes the baseline measurement, which is why it
    # is the one exposed as an argument.
    #
    # Class weighting is kept by measurement, not by folklore: without it
    # ROC-AUC is even slightly higher in five windows out of six, but PR-AUC
    # is lower in all six (0.2990 vs 0.3263 on the 2005 window). At a 2.87%
    # positive rate the rare class is what matters, hence "balanced". The
    # model does not collapse to a constant either way — that would be
    # `predict()` with a 0.5 threshold, but everything here reads
    # `predict_proba`.
    #
    # Hyperparameters were not tuned: the same ones on every backtest step.
    # The report says so — the reader assumes the opposite by default.
    return HistGradientBoostingClassifier(
        max_iter=400,
        learning_rate=0.05,
        max_leaf_nodes=63,
        min_samples_leaf=200,
        class_weight=class_weight,
        # Without a seed the binner subsamples rows at random and the run is
        # not repeatable: on the same window ROC-AUC drifted 0.9361 vs
        # 0.9363, PR-AUC 0.3280 vs 0.3240. For a report that prints four
        # digits and promises reproducibility that is not noise, it is a lie.
        random_state=20260728,
        # Early stopping would carve out the tail of the sample for
        # validation AT RANDOM. On temporal data that is the same leakage as
        # a random split.
        early_stopping=False,
    )


def train(
    plugin_id: str,
    model_version: str,
    dataset: str,
    calibration_fraction: float,
) -> dict:
    frame = load_dataset(dataset)
    features, dropped = usable_features(frame)
    fit_part, calib_part = split(frame, calibration_fraction)

    model = classifier()
    model.fit(fit_part[features], fit_part[LABEL].astype(int))

    raw = model.predict_proba(calib_part[features])[:, 1]
    y = calib_part[LABEL].astype(int).to_numpy()

    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(raw, y)

    os.makedirs(MODELS_DIR, exist_ok=True)
    artifact = os.path.join(MODELS_DIR, f"{model_version}.joblib")
    joblib.dump(
        {
            "pluginId": plugin_id,
            "features": features,
            "model": model,
            "calibrator": calibrator,
            "trainedAt": datetime.now(timezone.utc).isoformat(),
        },
        artifact,
    )

    return {
        "modelVersion": model_version,
        "trainRows": int(len(fit_part)),
        "calibrationRows": int(len(calib_part)),
        # Declared by the domain but undefined in this window. An empty list
        # is the normal case; a non-empty one must reach the report.
        "droppedFeatures": dropped,
        # Training-sample percentile per feature. Needed by scenario stress:
        # without it there is no way to tell whether a shock pushed the
        # portfolio into a region the model never trained on. A stress test
        # that does not state its extrapolation share is untrustworthy — the
        # model's answer there is unknown, not "just higher".
        #
        # Computed on the training part, not the calibration part: the
        # question is precisely what the model saw during training.
        "quantiles": {
            column: float(fit_part[column].quantile(0.99))
            for column in features
            if fit_part[column].notna().any()
        },
        # In-sample: computed by the calibrator on its own calibration
        # slice. Not stored and not reported (those use the test-window
        # evaluation from /evaluate) — the only reader is the training
        # completion log.
        "metrics": metrics(
            y, raw, calibrator.predict(raw), calib_part[EXPOSURE].to_numpy()
        ),
    }


def reliability(
    y: np.ndarray, p: np.ndarray, bins: int, weight: np.ndarray
) -> tuple[list[dict], float, float]:
    # Calibration curve: promised probability vs observed frequency. Bins by
    # probability, not by quantiles: the question is "when the model says
    # 30%, is it wrong 30% of the time", not how the predictions are
    # distributed.
    edges = np.linspace(0.0, 1.0, bins + 1)
    index = np.clip(np.digitize(p, edges[1:-1], right=False), 0, bins - 1)

    # ECE is computed twice over the same bins. The plain one weights a bin
    # by event count, the weighted one by their total exposure. The curve
    # and Kupiec stay event-based: they are statements about frequency, not
    # money, and there is nothing to weight them by.
    #
    # A zero-weight non-empty bin is not a made-up case: a mortgage balance
    # drops to zero in the month the loan closes, and such a bin contributes
    # nothing to the money total.
    total_weight = float(weight.sum())
    curve, ece, ece_weighted = [], 0.0, 0.0
    for b in range(bins):
        mask = index == b
        n = int(mask.sum())
        if n == 0:
            continue
        predicted = float(p[mask].mean())
        observed = float(y[mask].mean())
        ece += n / len(y) * abs(predicted - observed)

        bin_weight = float(weight[mask].sum())
        if bin_weight > 0:
            ece_weighted += (
                bin_weight
                / total_weight
                * abs(
                    float(np.average(p[mask], weights=weight[mask]))
                    - float(np.average(y[mask], weights=weight[mask]))
                )
            )
        curve.append(
            {
                "bin": b,
                "from": float(edges[b]),
                "to": float(edges[b + 1]),
                "count": n,
                "predicted": predicted,
                "observed": observed,
                "kupiecLR": _kupiec(n, int(y[mask].sum()), predicted),
            }
        )
    return curve, ece, ece_weighted


def exposure_deciles(
    y: np.ndarray,
    p: np.ndarray,
    weight: np.ndarray,
    severity: float,
    groups: int = 10,
) -> list[dict]:
    # The cut that answers "does the error depend on position size". Average
    # metrics cannot see it: the model can underestimate the probability
    # exactly on average while underestimating it three times harder on
    # large positions.
    #
    # Groups are equal by POSITION COUNT, not by money: otherwise the top
    # group would consist of a dozen loans and its observed frequency would
    # be noise.
    order = np.argsort(weight, kind="stable")
    size = len(order) // groups
    if size == 0:
        return []

    rows = []
    for g in range(groups):
        start = g * size
        stop = len(order) if g == groups - 1 else start + size
        idx = order[start:stop]

        predicted = float(p[idx].mean())
        observed = float(y[idx].mean())
        rows.append(
            {
                "decile": g + 1,
                "from": float(weight[idx].min()),
                "to": float(weight[idx].max()),
                "count": int(idx.size),
                "exposure": float(weight[idx].sum()),
                "predicted": predicted,
                "observed": observed,
                # In money terms — the same comparison, but exposure-weighted
                # and with LGD applied: a loan keeps its collateral, so the
                # event does not wipe the whole balance. Within a decile
                # balances are homogeneous, so the gap between these two
                # ratios inside a group is near zero, while across groups it
                # is exactly the slope.
                "predictedLoss": float((p[idx] * weight[idx]).sum() * severity),
                "realizedLoss": float((y[idx] * weight[idx]).sum() * severity),
            }
        )
    return rows


def _kupiec(n: int, hits: int, expected: float) -> float:
    # LR statistic of the Kupiec (1995) unconditional coverage test.
    # Originally a VaR test: does the breach frequency differ from the
    # stated one. In a calibration-curve bin it reduces to a binomial
    # proportion test — same machinery, different purpose, and the report
    # says so explicitly.
    #
    # Compared against chi2(1): 3.84 is the 5% boundary.
    if n == 0 or expected <= 0 or expected >= 1:
        return float("nan")
    observed = hits / n
    if observed in (0.0, 1.0):
        # Log of zero: the likelihood at the observed proportion degenerates.
        null = hits * np.log(expected) + (n - hits) * np.log1p(-expected)
        return float(-2 * null)
    alt = hits * np.log(observed) + (n - hits) * np.log1p(-observed)
    null = hits * np.log(expected) + (n - hits) * np.log1p(-expected)
    return float(-2 * (null - alt))


def evaluate(
    bundle: dict, dataset: str, bins: int, cases: int, severity: float
) -> dict:
    # Evaluation on a held-out window. The model arrives here already
    # trained: computing metrics in the same call that trains would mean
    # measuring on data chosen against the same time boundary.
    frame = load_dataset(dataset)
    missing = [c for c in bundle["features"] if c not in frame.columns]
    if missing:
        raise ValueError(f"the sample lacks the model's features: {missing}")

    y = frame[LABEL].astype(int).to_numpy()
    raw = bundle["model"].predict_proba(frame[bundle["features"]])[:, 1]
    calibrated = np.clip(bundle["calibrator"].predict(raw), 0.0, 1.0)

    weight = frame[EXPOSURE].to_numpy()
    curve, ece, ece_weighted = reliability(y, calibrated, bins, weight)
    return {
        "rows": int(len(frame)),
        "windowFrom": str(frame[AT].iloc[0]),
        "windowTo": str(frame[AT].iloc[-1]),
        "metrics": {
            **metrics(y, raw, calibrated, weight),
            "ece": ece,
            "eceWeighted": ece_weighted,
        },
        "reliability": curve,
        "deciles": exposure_deciles(y, calibrated, weight, severity),
        "cases": _cases(frame, y, calibrated, cases),
    }


def _cases(
    frame: pd.DataFrame, y: np.ndarray, p: np.ndarray, k: int
) -> dict[str, list[dict]]:
    # Extreme events of the window, not random ones: a case review pays off
    # where the model spoke with the most confidence — and was right or
    # wrong.
    #
    # Scores are never stored wholesale: at 26M events that is a separate
    # table for the sake of four report rows. We return candidates; the core
    # fetches the rest from its own database by eventId.
    ids = frame[ID].to_numpy()
    at = frame[AT].astype(str).to_numpy()

    def pick(mask: np.ndarray, order: np.ndarray) -> list[dict]:
        idx = np.flatnonzero(mask)
        if idx.size == 0:
            return []
        chosen = idx[np.argsort(order[idx])][:k]
        return [
            {"eventId": str(ids[i]), "at": str(at[i]), "probability": float(p[i])}
            for i in chosen
        ]

    return {
        # Caught: the loss happened, the model gave a high probability.
        "caught": pick(y == 1, -p),
        # Missed: the loss happened while the model deemed the event safe.
        # This category is the reason the report exists.
        "missed": pick(y == 1, p),
        # False alarm: no loss, yet the model insisted.
        "falsePositive": pick(y == 0, -p),
    }


def load(model_version: str) -> dict:
    artifact = os.path.join(MODELS_DIR, f"{model_version}.joblib")
    if not os.path.exists(artifact):
        raise FileNotFoundError(model_version)
    return joblib.load(artifact)


def predict(bundle: dict, vectors: list) -> list[dict]:
    # The column order comes from the artifact, not from the request: the
    # model tells features apart by position, and a shuffled order would
    # yield plausible-looking but wrong probabilities.
    frame = pd.DataFrame([v.values for v in vectors]).reindex(
        columns=bundle["features"]
    )
    raw = bundle["model"].predict_proba(frame)[:, 1]
    calibrated = bundle["calibrator"].predict(raw)

    return [
        {
            "eventId": vector.eventId,
            "raw": float(r),
            "probability": float(min(max(p, 0.0), 1.0)),
        }
        for vector, r, p in zip(vectors, raw, calibrated)
    ]
