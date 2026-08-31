import logging
import time

import numpy as np
from fastapi import FastAPI, HTTPException

from . import model, portfolio
from .schemas import (
    EvaluateRequest,
    EvaluateResponse,
    PortfolioRequest,
    PortfolioResponse,
    ScoreRequest,
    ScoreResponse,
    TrainRequest,
    TrainResponse,
)

# The service is thin on purpose: the core computes features, only
# prediction lives here. If features were also computed here, a second code
# path would appear and train/serve skew would be a matter of time. The
# training sample is literally what the core exported from FeatureVector,
# i.e. the same numbers that went to production.
app = FastAPI(title="MAMIR scoring", version="0.1.0")
logger = logging.getLogger("scoring")
logging.basicConfig(level=logging.INFO, format="%(message)s")

# The artifact is kept in memory between requests: unpickling the ensemble
# from disk on every scoring call would eat the entire latency budget.
_loaded: dict[str, dict] = {}


def _bundle(model_version: str) -> dict:
    if model_version not in _loaded:
        try:
            _loaded[model_version] = model.load(model_version)
        except FileNotFoundError:
            logger.warning(
                {
                    "actionCode": "scoring.main.bundle.not_found",
                    "modelVersion": model_version,
                }
            )
            raise HTTPException(404, f"model version {model_version} does not exist")
    return _loaded[model_version]


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/train", response_model=TrainResponse)
def train(request: TrainRequest) -> dict:
    started = time.monotonic()
    try:
        report = model.train(
            request.pluginId,
            request.modelVersion,
            request.dataset,
            request.calibrationFraction,
        )
    except (ValueError, FileNotFoundError) as error:
        logger.error(
            {
                "actionCode": "scoring.main.train.rejected",
                "dataset": request.dataset,
                "message": str(error),
            }
        )
        raise HTTPException(400, str(error))

    logger.info(
        {
            "actionCode": "scoring.main.train.completed",
            "pluginId": request.pluginId,
            "modelVersion": report["modelVersion"],
            "trainRows": report["trainRows"],
            "calibrationRows": report["calibrationRows"],
            "metrics": report["metrics"],
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
    )
    return report


@app.post("/evaluate", response_model=EvaluateResponse)
def evaluate(request: EvaluateRequest) -> dict:
    started = time.monotonic()
    try:
        report = model.evaluate(
            _bundle(request.modelVersion),
            request.dataset,
            request.bins,
            request.cases,
            request.severity,
        )
    except (ValueError, FileNotFoundError) as error:
        logger.error(
            {
                "actionCode": "scoring.main.evaluate.rejected",
                "dataset": request.dataset,
                "message": str(error),
            }
        )
        raise HTTPException(400, str(error))

    logger.info(
        {
            "actionCode": "scoring.main.evaluate.completed",
            "modelVersion": request.modelVersion,
            "rows": report["rows"],
            "window": [report["windowFrom"], report["windowTo"]],
            "metrics": report["metrics"],
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
    )
    return report


@app.post("/portfolio", response_model=PortfolioResponse)
def portfolio_distribution(request: PortfolioRequest) -> dict:
    # Portfolio loss distribution. The core sends precomputed probabilities
    # and exposures, the service draws the common factor — a numerical numpy
    # problem, not data work.
    started = time.monotonic()
    try:
        report = portfolio.simulate(
            np.asarray(request.probability),
            np.asarray(request.exposure),
            request.severity,
            request.correlation,
            request.scenarios,
            request.seed,
            request.realized,
        )
    except ValueError as error:
        logger.error(
            {
                "actionCode": "scoring.main.portfolio.rejected",
                "positions": len(request.probability),
                "message": str(error),
            }
        )
        raise HTTPException(400, str(error))

    logger.info(
        {
            "actionCode": "scoring.main.portfolio.completed",
            "positions": len(request.probability),
            "scenarios": request.scenarios,
            "rho": request.correlation,
            "expectedLoss": report["expectedLoss"],
            "var999": report["var999"],
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
    )
    return report


@app.post("/score", response_model=ScoreResponse)
def score(request: ScoreRequest) -> dict:
    started = time.monotonic()
    scores = model.predict(_bundle(request.modelVersion), request.vectors)

    logger.info(
        {
            "actionCode": "scoring.main.score.completed",
            "modelVersion": request.modelVersion,
            "vectors": len(scores),
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
    )
    return {"scores": scores}
