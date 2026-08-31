from pydantic import BaseModel, Field

# Mirror of packages/contracts/src/score.ts. They must not diverge: Zod on
# one side of the interface, Pydantic on the other, no shared code — the
# match holds because both describe one contract, not because they are
# generated.


class Vector(BaseModel):
    eventId: str
    # A feature may be null: an empty window, an axis absent from the event.
    # That is a valid value, not an error — histogram gradient boosting
    # handles missing values natively.
    values: dict[str, float | None]


class ScoreRequest(BaseModel):
    modelVersion: str
    vectors: list[Vector] = Field(min_length=1)


class Score(BaseModel):
    eventId: str
    # raw — before calibration, probability — after. We keep both: otherwise
    # there is no way to see that calibration does anything at all.
    raw: float
    probability: float


class ScoreResponse(BaseModel):
    scores: list[Score]


class TrainRequest(BaseModel):
    pluginId: str
    # The version identifier comes from the core rather than being generated
    # here: one thing must have one name, and the core stores versions.
    #
    # The pattern is not paranoia: the value becomes a file name, and
    # without it `../` sneaks in. This is a system boundary; validation here
    # is mandatory.
    modelVersion: str = Field(pattern=r"^[0-9a-fA-F-]{32,36}$")
    # Path to the parquet the core exported. The training sample arrives as
    # a file, not a request body: pre-2008 training is eight million rows —
    # gigabytes in JSON. The file also becomes the artifact that makes the
    # run reproducible a month later.
    dataset: str
    # Fraction of the sample tail BY TIME that goes to calibration. A random
    # split on temporal data inflates calibration the same way leakage
    # inflates AUC, so the split is chronological only.
    calibrationFraction: float = Field(default=0.2, gt=0, lt=1)


class TrainResponse(BaseModel):
    modelVersion: str
    trainRows: int
    calibrationRows: int
    # Features declared by the plugin but empty across the whole window: the
    # field appeared in the source after the sample starts. The model never
    # saw them.
    droppedFeatures: list[str]
    # 99th percentile of the training sample per feature — the basis for the
    # extrapolation share in the scenario report.
    quantiles: dict[str, float]
    # In-sample; the reader is the training completion log. Not persisted.
    metrics: dict[str, float]


class EvaluateRequest(BaseModel):
    modelVersion: str
    dataset: str
    # Calibration-curve bins. Ten is a project convention, not magic: fewer
    # hides the curve's shape, more leaves bins empty on a rare event.
    bins: int = Field(default=10, ge=2, le=50)
    # How many extreme events to return in each case category.
    cases: int = Field(default=5, ge=0, le=50)
    # LGD: the fraction of exposure lost when the event occurs. Declared by
    # the domain and supplied by the core; deliberately no default — a unit
    # value accepted silently is exactly the mistake this field exists to
    # prevent.
    severity: float = Field(gt=0, le=1)


class ReliabilityBin(BaseModel):
    bin: int
    # Bin boundaries by predicted probability.
    from_: float = Field(alias="from")
    to: float
    count: int
    predicted: float
    observed: float
    # Kupiec LR statistic for this bin, chi2(1): 3.84 is the 5% boundary.
    kupiecLR: float

    model_config = {"populate_by_name": True}


class ExposureDecile(BaseModel):
    # Groups are equal by position count; boundaries are by exposure.
    decile: int
    from_: float = Field(alias="from")
    to: float
    count: int
    exposure: float
    # Promised probability vs observed frequency within the group, and the
    # same in money terms. The SLOPE divergence across groups is what
    # average metrics cannot show by construction.
    predicted: float
    observed: float
    predictedLoss: float
    realizedLoss: float

    model_config = {"populate_by_name": True}


class Case(BaseModel):
    eventId: str
    at: str
    probability: float


class EvaluateResponse(BaseModel):
    rows: int
    windowFrom: str
    windowTo: str
    metrics: dict[str, float]
    reliability: list[ReliabilityBin]
    deciles: list[ExposureDecile]
    # caught — the loss happened and the model called it; missed — the loss
    # happened while the model deemed the event safe; falsePositive — the
    # model insisted, no loss occurred.
    cases: dict[str, list[Case]]


class PortfolioRequest(BaseModel):
    # Probabilities and exposures arrive precomputed: the core produces
    # them, the service only draws the distribution. Not a single domain
    # concept here — no loan, no transaction, only numbers and model
    # parameters.
    probability: list[float]
    exposure: list[float]
    severity: float = Field(gt=0, le=1)
    # Zero is allowed and means independent positions; one is not — with it
    # the portfolio degenerates into a single position.
    correlation: float = Field(ge=0, lt=1)
    # More paths — a more accurate tail. At 50,000 only about fifty outcomes
    # remain beyond the 99.9% quantile, and its Monte Carlo error is already
    # visible; the report must state the path count next to the quantile.
    # The cap is aligned with transport: the core waits at most 30 minutes
    # for a response, and 200k paths on a 200k-position portfolio take ~17
    # minutes (measured: 4×10⁷ position-paths per second). Allowing a
    # million would promise what cannot finish in time.
    scenarios: int = Field(default=50_000, ge=1_000, le=200_000)
    # The seed is mandatory and comes from outside: the simulation must be
    # as reproducible as training, otherwise two identical requests would
    # yield different tails.
    seed: int
    # The actually realized loss, if known (a historical run). Its
    # percentile is computed on the simulation side over the raw path array
    # — outside, from the histogram, it would carry a bin-width error.
    realized: float | None = None


class Histogram(BaseModel):
    counts: list[int]
    edges: list[float]


class RealizedPlacement(BaseModel):
    value: float
    # Fraction of paths strictly below the realized loss: "it was this bad
    # in 1 − p of the paths". Exact, over the scenario array, not the
    # histogram.
    percentile: float


class PortfolioResponse(BaseModel):
    # The analytic mean and the simulated one travel together: their gap is
    # a built-in check that the simulation has not diverged from the loss
    # formula.
    expectedLoss: float
    simulatedMean: float
    unexpectedLoss: float
    var99: float
    var999: float
    es975: float
    max: float
    scenarios: int
    rho: float
    realized: RealizedPlacement | None
    histogram: Histogram
