import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FeatureValues } from '@mamir/contracts'
import type { Env } from '../config/env'
import { DatasetService } from '../dataset/dataset.service'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'

export interface BacktestOptions {
	pluginId: string
	// The start of the first TEST window. Everything earlier goes into training
	// the first step: there has to be enough history, or the first model trains
	// on nothing.
	testFrom: Date
	// Step length. The model is retrained on each one.
	stepMonths: number
	steps: number
	// The root for extracts. The domain directory inside it is added by the run
	// itself — it cannot be forgotten from outside.
	workDir: string
	// The tail share of the training sample used for calibration — by time, not
	// at random.
	calibrationFraction: number
}

export interface StepReport {
	step: number
	trainUntil: string
	testFrom: string
	testTo: string
	modelVersion: string
	trainRows: number
	testRows: number
	droppedFeatures: string[]
	metrics: Record<string, number>
}

export interface BacktestReport {
	executionId: string
	runIds: string[]
	steps: StepReport[]
	elapsedMs: number
}

export interface RunView {
	id: string
	pluginId: string
	// The execution a window belongs to. Null on runs made before tracking was
	// introduced: they cannot be compared with new ones row by row, and the
	// reader has to see that rather than infer it from a date.
	executionId: string | null
	window: { from: string; to: string }
	model: { id: string; trainWindowEnd: string; calibration: string }
	metrics: Record<string, number>
	reliability: ReliabilityBin[]
	deciles: ExposureDecile[]
	cases: number
	createdAt: string
}

export interface CaseView {
	name: string
	kind: string
	probability: number
	eventId: string
	occurredAt: string
	entityKeys: Record<string, string>
	exposure: string
	outcome: { value: boolean; resolvedAt: string } | null
	values: FeatureValues | null
}

// Walk-forward with not a single random split. At every step the model sees
// only the past: the training sample ends where the test one begins, and its
// labels have matured as of the same moment. The model of step N knows nothing
// about the data of step N+1 — that is what makes the result a backtest rather
// than a fit.
//
// The core orchestrates, the scoring service computes. That does not blur the
// boundary: windows, extracts and storing runs are here, sklearn is there.
@Injectable()
export class BacktestService {
	private readonly logger = new Logger(BacktestService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
		private readonly dataset: DatasetService,
		private readonly config: ConfigService<Env, true>,
	) {}

	async run(options: BacktestOptions): Promise<BacktestReport> {
		const plugin = this.registry.get(options.pluginId)
		const startedAt = Date.now()

		// The domain is part of the path, not a CLI default: step extracts are
		// named train-0, test-0 and so on, and two domains in one directory
		// silently overwrite each other. Scoping by pluginId is as mandatory
		// here as everywhere else in the project.
		const workDir = resolvePath(options.workDir, plugin.id)
		await mkdir(workDir, { recursive: true })

		// One identifier for the whole execution: windows of one backtest were
		// computed by one code on one dataset and are comparable with each
		// other, windows of different executions are not. Without it "show the
		// last backtest" would have to be guessed.
		const executionId = randomUUID()

		const steps: StepReport[] = []
		const runIds: string[] = []

		for (let step = 0; step < options.steps; step++) {
			const testFrom = addMonths(options.testFrom, step * options.stepMonths)
			const testTo = addMonths(testFrom, options.stepMonths)

			// The training sample ends exactly where the test one begins. Inside
			// it the last share goes to calibration — also by time.
			//
			// The path is absolute: it travels to the scoring service over HTTP,
			// and that is a separate process with its own working directory. A
			// relative path in such a contract means different files for sender
			// and receiver.
			const trainPath = resolvePath(workDir, `train-${step}.csv`)
			const testPath = resolvePath(workDir, `test-${step}.csv`)

			// Training: a label has to mature by the training boundary.
			// Evaluation: a label has to be mature at all — how the test window
			// ended is known today, and the model never looked there anyway. One
			// boundary for both cases would leave the first month of an annual
			// window.
			const train = await this.dataset.export({
				pluginId: plugin.id,
				until: testFrom,
				maturedBy: testFrom,
				out: trainPath,
			})
			const test = await this.dataset.export({
				pluginId: plugin.id,
				from: testFrom,
				until: testTo,
				maturedBy: 'history-end',
				out: testPath,
			})

			if (train.rows === 0 || test.rows === 0) {
				this.logger.warn({
					actionCode: 'backtest.service.run.skipped',
					step,
					trainRows: train.rows,
					testRows: test.rows,
					reason: 'empty window',
				})
				continue
			}

			// The version id is generated by the core and passed into training:
			// the scoring service names the artifact by it, and the version is
			// stored in the database under it. While Python minted it, one model
			// had two names, and getting the right one meant a regex over the
			// file path.
			const modelVersion = randomUUID()

			const trained = await this.call<TrainResult>('/train', {
				pluginId: plugin.id,
				modelVersion,
				dataset: trainPath,
				calibrationFraction: options.calibrationFraction,
			})

			const evaluated = await this.call<EvaluateResult>('/evaluate', {
				modelVersion,
				dataset: testPath,
				// The domain's loss given default: deciles compare predicted with
				// observed in money, and without it both sides would mean "it
				// happened — everything was lost".
				severity: plugin.exposure.severity,
			})

			const model = await this.prisma.modelVersion.create({
				data: {
					id: modelVersion,
					pluginId: plugin.id,
					trainWindowEnd: testFrom,
					calibration: 'isotonic',
					quantiles: trained.quantiles,
				},
			})

			const run = await this.prisma.backtestRun.create({
				data: {
					pluginId: plugin.id,
					executionId,
					modelVersionId: model.id,
					windowFrom: testFrom,
					windowTo: testTo,
					metrics: evaluated.metrics,
					reliability: evaluated.reliability,
					deciles: evaluated.deciles,
				},
			})
			runIds.push(run.id)
			await this.saveCases(run.id, evaluated.cases)

			const report: StepReport = {
				step,
				trainUntil: testFrom.toISOString().slice(0, 10),
				testFrom: testFrom.toISOString().slice(0, 10),
				testTo: testTo.toISOString().slice(0, 10),
				modelVersion,
				trainRows: train.rows,
				testRows: test.rows,
				droppedFeatures: trained.droppedFeatures,
				metrics: evaluated.metrics,
			}
			steps.push(report)

			this.logger.log({
				actionCode: 'backtest.service.run.step',
				pluginId: plugin.id,
				runId: run.id,
				...report,
			})
		}

		const result: BacktestReport = {
			executionId,
			runIds,
			steps,
			elapsedMs: Date.now() - startedAt,
		}

		this.logger.log({
			actionCode: 'backtest.service.run.completed',
			pluginId: plugin.id,
			executionId,
			steps: steps.length,
			elapsedMs: result.elapsedMs,
		})

		return result
	}

	// Runs with their metrics. The window and the model version travel together
	// with the metrics rather than in a separate request: a metric cannot be
	// read without them, and splitting them across responses would permit
	// showing one without the other.
	async runs(pluginId?: string): Promise<RunView[]> {
		const runs = await this.prisma.backtestRun.findMany({
			where: pluginId ? { pluginId } : {},
			orderBy: [{ pluginId: 'asc' }, { windowFrom: 'asc' }],
			select: {
				id: true,
				pluginId: true,
				executionId: true,
				windowFrom: true,
				windowTo: true,
				metrics: true,
				reliability: true,
				deciles: true,
				createdAt: true,
				modelVersion: {
					select: { id: true, trainWindowEnd: true, calibration: true },
				},
				_count: { select: { cases: true } },
			},
		})

		return runs.map((run) => ({
			id: run.id,
			pluginId: run.pluginId,
			executionId: run.executionId,
			window: {
				from: run.windowFrom.toISOString(),
				to: run.windowTo.toISOString(),
			},
			model: {
				id: run.modelVersion.id,
				trainWindowEnd: run.modelVersion.trainWindowEnd.toISOString(),
				calibration: run.modelVersion.calibration,
			},
			metrics: run.metrics as Record<string, number>,
			reliability: run.reliability as ReliabilityBin[],
			deciles: run.deciles as ExposureDecile[],
			cases: run._count.cases,
			createdAt: run.createdAt.toISOString(),
		}))
	}

	// A case opens together with the feature vector as of the event — that is
	// how the acceptance criterion is written. There are no copies of this data
	// in the case: the moment, exposure and axes live in Event, the vector in
	// FeatureVector, the outcome in Label, and a foreign key guarantees all of
	// it is there.
	async cases(runId: string): Promise<CaseView[]> {
		const run = await this.prisma.backtestRun.findUnique({
			where: { id: runId },
			select: { id: true },
		})

		if (!run) {
			this.logger.warn({
				actionCode: 'backtest.service.cases.not_found',
				runId,
			})
			throw new NotFoundException(`run ${runId} does not exist`)
		}

		const cases = await this.prisma.backtestCase.findMany({
			where: { runId },
			orderBy: { name: 'asc' },
			select: {
				name: true,
				kind: true,
				probability: true,
				eventId: true,
				event: {
					select: {
						occurredAt: true,
						entityKeys: true,
						exposure: true,
						vector: { select: { values: true } },
						label: { select: { value: true, resolvedAt: true } },
					},
				},
			},
		})

		return cases.map((item) => ({
			name: item.name,
			kind: item.kind,
			probability: item.probability,
			eventId: item.eventId,
			occurredAt: item.event.occurredAt.toISOString(),
			entityKeys: item.event.entityKeys as Record<string, string>,
			exposure: item.event.exposure.toString(),
			outcome: item.event.label && {
				value: item.event.label.value,
				resolvedAt: item.event.label.resolvedAt.toISOString(),
			},
			values: (item.event.vector?.values ?? null) as FeatureValues | null,
		}))
	}

	// Cases for the report: three hits and — mandatory — one miss. A report
	// showing only hits is marketing, not a backtest.
	//
	// A case is a reference to an event plus what the model said about it. The
	// moment lives in Event, the feature vector in FeatureVector, the outcome in
	// Label, and all of it is reached by a join on eventId; there is nothing to
	// copy here. The prose about the loan and its collateral is written by a
	// human in the domain report.
	private async saveCases(
		runId: string,
		cases: Record<string, CaseCandidate[]>,
	): Promise<void> {
		const selection: [string, CaseCandidate | undefined][] = [
			['CAUGHT', cases.caught?.[0]],
			['CAUGHT', cases.caught?.[1]],
			['CAUGHT', cases.caught?.[2]],
			['MISSED', cases.missed?.[0]],
			['FALSE_POSITIVE', cases.falsePositive?.[0]],
		]

		let index = 0
		const rows = selection.flatMap(([kind, candidate]) =>
			candidate
				? [
						{
							runId,
							name: `${kind.toLowerCase()}-${++index}`,
							eventId: candidate.eventId,
							kind,
							probability: candidate.probability,
						},
					]
				: [],
		)

		await this.prisma.backtestCase.createMany({ data: rows })
	}

	private async call<T>(path: string, body: unknown): Promise<T> {
		const base = this.config.get('SCORING_URL', { infer: true })
		const startedAt = Date.now()
		const response = await fetch(`${base}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const detail = await response.text()
			this.logger.error({
				actionCode: 'backtest.service.call.error',
				path,
				status: response.status,
				detail,
			})
			throw new Error(`${path} returned ${response.status}: ${detail}`)
		}

		this.logger.log({
			actionCode: 'backtest.service.call.completed',
			path,
			latencyMs: Date.now() - startedAt,
		})
		return (await response.json()) as T
	}
}

interface TrainResult {
	modelVersion: string
	droppedFeatures: string[]
	quantiles: Record<string, number>
}

// A calibration curve bin. The core does not interpret it — it puts it into
// the report; but the type is needed so that `unknown` does not slip into a
// JSON column silently.
//
// type, not interface: Prisma accepts only structures with an index signature
// into Json, and interfaces do not get one implicitly.
type ReliabilityBin = {
	bin: number
	from: number
	to: number
	count: number
	predicted: number
	observed: number
	kupiecLR: number
}

// A cut of the window by amount at risk: groups of equal event count, ordered
// by exposure. It answers a question no average metric has — does the model's
// error grow with position size.
type ExposureDecile = {
	decile: number
	from: number
	to: number
	count: number
	exposure: number
	predicted: number
	observed: number
	predictedLoss: number
	realizedLoss: number
}

interface CaseCandidate {
	eventId: string
	at: string
	probability: number
}

interface EvaluateResult {
	rows: number
	metrics: Record<string, number>
	reliability: ReliabilityBin[]
	deciles: ExposureDecile[]
	cases: Record<string, CaseCandidate[]>
}

// The step is in months, not days: balance-sheet domains have monthly
// granularity, and a 30-day step would drift out of sync with reporting periods
// by the second year.
function addMonths(date: Date, months: number): Date {
	const shifted = new Date(date)
	shifted.setUTCMonth(shifted.getUTCMonth() + months)
	return shifted
}
