-- The schema as one baseline migration.
--
-- The step-by-step history that led here lived in thirteen migrations and is
-- gone with the repository it documented: applied history is not a design
-- record, and a fresh clone only needs the shape the code expects today.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "pluginId" TEXT NOT NULL,
    "entityKeys" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exposure" DECIMAL(18,4) NOT NULL,
    "payload" JSONB NOT NULL,
    "ingestRunId" UUID,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" UUID NOT NULL,
    "pluginId" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "eventId" UUID NOT NULL,
    "value" BOOLEAN NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "FeatureVector" (
    "id" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "values" JSONB NOT NULL,

    CONSTRAINT "FeatureVector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trainWindowEnd" TIMESTAMP(3) NOT NULL,
    "calibration" TEXT NOT NULL,
    "quantiles" JSONB NOT NULL,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "executionId" UUID,
    "modelVersionId" TEXT NOT NULL,
    "windowFrom" TIMESTAMP(3) NOT NULL,
    "windowTo" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "reliability" JSONB NOT NULL,
    "deciles" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestCase" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "BacktestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioRun" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "lookback" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "positions" INTEGER NOT NULL,
    "exposure" DECIMAL(18,4) NOT NULL,
    "baseEL" DECIMAL(18,4) NOT NULL,
    "stressedEL" DECIMAL(18,4) NOT NULL,
    "affected" INTEGER NOT NULL,
    "recomputed" TEXT[],
    "coverage" JSONB NOT NULL,
    "extrapolation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalRun" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "lookback" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "trainedTo" TIMESTAMP(3) NOT NULL,
    "positions" INTEGER NOT NULL,
    "compared" INTEGER NOT NULL,
    "exposure" DECIMAL(18,4) NOT NULL,
    "predictedEL" DECIMAL(18,4) NOT NULL,
    "realizedLoss" DECIMAL(18,4) NOT NULL,
    "expectedPositives" DOUBLE PRECISION NOT NULL,
    "observedPositives" INTEGER NOT NULL,
    "withoutVector" INTEGER NOT NULL,
    "withoutLabel" INTEGER NOT NULL,
    "unmatured" INTEGER NOT NULL,
    "deciles" JSONB NOT NULL,
    "distribution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_pluginId_occurredAt_idx" ON "Event"("pluginId", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_pluginId_ingestedAt_idx" ON "Event"("pluginId", "ingestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IngestRun_pluginId_cohort_key" ON "IngestRun"("pluginId", "cohort");

-- CreateIndex
CREATE INDEX "Label_resolvedAt_idx" ON "Label"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureVector_eventId_key" ON "FeatureVector"("eventId");

-- CreateIndex
CREATE INDEX "ModelVersion_pluginId_trainedAt_idx" ON "ModelVersion"("pluginId", "trainedAt");

-- CreateIndex
CREATE INDEX "BacktestRun_pluginId_createdAt_idx" ON "BacktestRun"("pluginId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestRun_pluginId_executionId_idx" ON "BacktestRun"("pluginId", "executionId");

-- CreateIndex
CREATE INDEX "BacktestCase_runId_idx" ON "BacktestCase"("runId");

-- CreateIndex
CREATE INDEX "ScenarioRun_pluginId_createdAt_idx" ON "ScenarioRun"("pluginId", "createdAt");

-- CreateIndex
CREATE INDEX "HistoricalRun_pluginId_createdAt_idx" ON "HistoricalRun"("pluginId", "createdAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ingestRunId_fkey" FOREIGN KEY ("ingestRunId") REFERENCES "IngestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureVector" ADD CONSTRAINT "FeatureVector_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestCase" ADD CONSTRAINT "BacktestCase_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestCase" ADD CONSTRAINT "BacktestCase_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

