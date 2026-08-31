import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { FeatureSpec, FeatureValues, ScenarioSpec } from '@mamir/contracts'
import { ExposureService, type Position } from '../exposure/exposure.service'
import { expectedLoss } from '../exposure/loss'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'
import { ScoringService } from '../scoring/scoring.service'
import {
	bulkFeatureSql,
	longestWindow,
	positionSql,
	shockCoverageSql,
	shockReader,
	windowMs,
} from '../windows/window-sql'

export interface ScenarioOptions {
	pluginId: string
	scenarioId: string
	at: Date
	lookback: string
}

// type, not interface: Prisma accepts only structures with an index signature
// into Json, and interfaces do not get one implicitly.
export type ShockCoverage = {
	scanned: number
	selected: number
	// How many rows actually changed for each shocked field. Zero with a
	// non-empty selected means the field is absent from the events.
	shocked: Record<string, number>
}

export type Extrapolation = {
	p99: number | null
	base: number
	stressed: number
}

// A stored run. It differs from the report by having no elapsedMs and having
// createdAt: the first is a property of the execution, the second of the
// record.
export interface ScenarioRunView {
	id: string
	pluginId: string
	scenarioId: string
	at: string
	lookback: string
	modelVersion: string
	positions: number
	exposure: number
	baseEL: number
	stressedEL: number
	deltaEL: number
	affected: number
	recomputed: string[]
	coverage: ShockCoverage
	extrapolation: Record<string, Extrapolation>
	createdAt: string
}

export interface ScenarioReport {
	runId: string
	pluginId: string
	scenarioId: string
	title: string
	at: string
	lookback: string
	modelVersion: string
	positions: number
	exposure: number
	baseEL: number
	stressedEL: number
	deltaEL: number
	affected: number
	// The features a shock can reach at all: those whose declaration mentions
	// the shocked field. Derived from the declaration, not from knowledge of the
	// domain.
	recomputed: string[]
	coverage: ShockCoverage
	extrapolation: Record<string, Extrapolation>
	elapsedMs: number
}

// Scenario stress. The shock is applied to an event FIELD, and features are
// recomputed by the same window compiler that computes them during training and
// scoring.
//
// What a scenario actually asks: "if the last year had looked like this, what
// would the model say today". Not "if it happens tomorrow", because a feature
// as of time t looks strictly backwards: shifting only today's event shifts
// nothing — its own values do not enter its own vector.
@Injectable()
export class ScenariosService {
	private readonly logger = new Logger(ScenariosService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
		private readonly exposure: ExposureService,
		private readonly scoring: ScoringService,
	) {}

	async run(options: ScenarioOptions): Promise<ScenarioReport> {
		const startedAt = Date.now()
		const plugin = this.registry.get(options.pluginId)
		const scenario = plugin.scenarios.find((s) => s.id === options.scenarioId)

		if (!scenario) {
			throw new NotFoundException(
				`plugin ${plugin.id} has no scenario "${options.scenarioId}"`,
			)
		}

		const model = await this.scoring.versionAsOf(plugin.id, options.at)
		if (!model) {
			throw new NotFoundException(
				`plugin ${plugin.id} has no model trained by ${options.at.toISOString()}`,
			)
		}

		// A shock reaches the model only through features whose declaration
		// mentions the shocked field. The rest cannot change: a shock edits
		// values, not the composition of a window, so an aggregate over another
		// field stays as it was. This follows from the declaration, not from
		// knowledge of the domain.
		const shocked = new Set(scenario.shock.map((s) => s.field))
		const recomputed = plugin.features.filter(
			(spec) =>
				(spec.source && shocked.has(spec.source)) ||
				spec.where.some((p) => shocked.has(p.field)),
		)

		// The scan has to fit the window of every recomputed feature for the
		// earliest position: [t − lookback − the longest window, t].
		const span = `${Math.round(
			(windowMs(options.lookback) +
				(recomputed.length
					? windowMs(longestWindow(recomputed.map((s) => s.window)))
					: 0)) /
				86_400_000,
		)}d`

		const positions = await this.exposure.portfolio(options)
		const scorable = positions.filter((p) => p.values !== null)

		const coverage = await this.coverage(plugin.id, scenario, span, options.at)
		const stressedValues = await this.recompute(
			plugin.id,
			scenario,
			recomputed,
			options,
			span,
		)

		const baseVectors = scorable.map((p) => ({
			eventId: p.eventId,
			values: p.values as FeatureValues,
		}))
		const stressedVectors = scorable.map((p) => ({
			eventId: p.eventId,
			values: {
				...(p.values as FeatureValues),
				...(stressedValues.get(p.eventId) ?? {}),
			},
		}))

		const base = await this.scoring.scoreAll(model.id, baseVectors)
		const after = await this.scoring.scoreAll(model.id, stressedVectors)

		// Loss given default is the third multiplier of expected loss, declared
		// by the domain. It does not affect ΔEL in percent (a common multiplier
		// cancels), but without it the absolute amounts would mean "a default
		// takes the whole balance".
		const severity = plugin.exposure.severity
		// No fallback for the probability: scoreAll throws on a shortfall of
		// scores, and an unreachable `?? 0` would disguise it as a safe
		// position.
		const el = (
			rows: Position[],
			scores: Map<string, { probability: number }>,
		): number =>
			rows.reduce(
				(sum, p) =>
					sum +
					expectedLoss(
						scores.get(p.eventId)!.probability,
						severity,
						p.exposure,
					),
				0,
			)

		// Exposure is recomputed only if its own field is shocked. On a
		// balance-sheet domain that never happens — the rate and LTV are shocked
		// while what is at risk is the outstanding balance. On a flow domain it
		// always happens: what is at risk is the amount of the transaction
		// itself, and that is what gets shocked. Keeping the base amount in that
		// case would mean counting the shift in probability and losing the shift
		// in amount.
		const shockedExposure = shocked.has(plugin.exposure.path)
			? await this.exposureUnder(plugin.id, scenario, options)
			: new Map<string, number>()

		const baseEL = el(scorable, base)
		const stressedEL = scorable.reduce(
			(sum, p) =>
				sum +
				expectedLoss(
					after.get(p.eventId)!.probability,
					severity,
					shockedExposure.get(p.eventId) ?? p.exposure,
				),
			0,
		)
		const affected = scorable.filter((p) =>
			moved(p.values as FeatureValues, stressedValues.get(p.eventId)),
		).length

		const extrapolation = await this.extrapolation(model.id, recomputed, {
			base: baseVectors,
			stressed: stressedVectors,
		})

		const report = {
			pluginId: plugin.id,
			scenarioId: scenario.id,
			title: scenario.title,
			at: options.at.toISOString(),
			lookback: options.lookback,
			modelVersion: model.id,
			positions: positions.length,
			exposure: positions.reduce((sum, p) => sum + p.exposure, 0),
			baseEL,
			stressedEL,
			deltaEL: stressedEL - baseEL,
			affected,
			recomputed: recomputed.map((spec) => spec.name),
			coverage,
			extrapolation,
			elapsedMs: Date.now() - startedAt,
		}

		const run = await this.prisma.scenarioRun.create({
			data: {
				pluginId: report.pluginId,
				scenarioId: report.scenarioId,
				asOf: options.at,
				lookback: report.lookback,
				modelVersionId: report.modelVersion,
				positions: report.positions,
				exposure: report.exposure,
				baseEL: report.baseEL,
				stressedEL: report.stressedEL,
				affected: report.affected,
				recomputed: report.recomputed,
				coverage: { ...report.coverage },
				extrapolation: report.extrapolation,
			},
			select: { id: true },
		})

		// A scenario that moved not a single value is not a zero effect but a run
		// that did not happen. By ΔEL the two cases are indistinguishable, so the
		// difference has to be visible at least in the log.
		this.logger[affected === 0 ? 'warn' : 'log']({
			actionCode: `scenarios.service.run.${affected === 0 ? 'untouched' : 'completed'}`,
			runId: run.id,
			...report,
		})

		return { runId: run.id, ...report }
	}

	// Stored runs. A dashboard has to read a result, not launch a
	// recomputation: a scenario on a balance-sheet domain runs for minutes, and
	// that cannot be the response to opening a page.
	//
	// There is deliberately no scenario title here: it lives in the plugin
	// declaration and is served by `GET /scenarios`. A copy in the run would
	// drift from the original on the first edit of the text.
	async runs(pluginId?: string): Promise<ScenarioRunView[]> {
		const runs = await this.prisma.scenarioRun.findMany({
			where: pluginId ? { pluginId } : {},
			orderBy: { createdAt: 'desc' },
		})

		return runs.map((run) => ({
			id: run.id,
			pluginId: run.pluginId,
			scenarioId: run.scenarioId,
			at: run.asOf.toISOString(),
			lookback: run.lookback,
			modelVersion: run.modelVersionId,
			positions: run.positions,
			exposure: Number(run.exposure),
			baseEL: Number(run.baseEL),
			stressedEL: Number(run.stressedEL),
			deltaEL: Number(run.stressedEL) - Number(run.baseEL),
			affected: run.affected,
			recomputed: run.recomputed,
			coverage: run.coverage as ShockCoverage,
			extrapolation: run.extrapolation as Record<string, Extrapolation>,
			createdAt: run.createdAt.toISOString(),
		}))
	}

	private async coverage(
		pluginId: string,
		scenario: ScenarioSpec,
		span: string,
		at: Date,
	): Promise<ShockCoverage> {
		const [row] = await this.prisma.$queryRawUnsafe<Record<string, number>[]>(
			shockCoverageSql(pluginId, scenario, span),
			at,
		)
		return {
			scanned: row.scanned,
			selected: row.selected,
			shocked: Object.fromEntries(
				scenario.shock.map((s, i) => [s.field, row[`shocked${i}`]]),
			),
		}
	}

	// Portfolio exposure under a shock. The same positionSql, only it reads the
	// shocked source and takes the amount from payload rather than from the
	// ready column: the column was computed on intake and knows nothing about
	// the shock.
	private async exposureUnder(
		pluginId: string,
		scenario: ScenarioSpec,
		options: ScenarioOptions,
	): Promise<Map<string, number>> {
		const plugin = this.registry.get(pluginId)
		const rows = await this.prisma.$queryRawUnsafe<
			{ id: string; exposure: number | null }[]
		>(
			`SELECT id, exposure FROM (${positionSql(
				pluginId,
				plugin.exposure,
				options.lookback,
				shockReader(scenario),
			)}) p`,
			options.at,
		)

		return new Map(
			rows
				.filter((row) => row.exposure !== null)
				.map((row) => [row.id, Number(row.exposure)]),
		)
	}

	// Recomputing features under a shock. The same bulkFeatureSql that computes
	// training vectors — it differs only in the payload source and the scan
	// bounds.
	private async recompute(
		pluginId: string,
		scenario: ScenarioSpec,
		specs: FeatureSpec[],
		options: ScenarioOptions,
		span: string,
	): Promise<Map<string, FeatureValues>> {
		if (specs.length === 0) return new Map()

		const plugin = this.registry.get(pluginId)
		const columns = specs.map((spec) => `f."${spec.name}"`).join(', ')

		// The join with the portfolio happens inside the query rather than as
		// filtering in Node: the windowed pass computes features for every event
		// in the scan — millions of rows, of which hundreds of thousands are
		// needed.
		const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
			`SELECT f.id, ${columns}
			 FROM (${bulkFeatureSql(pluginId, specs, { span, read: shockReader(scenario) })}) f
			 JOIN (${positionSql(pluginId, plugin.exposure, options.lookback)}) p
			   ON p.id = f.id
			 WHERE p.exposure > 0`,
			options.at,
		)

		return new Map(
			rows.map((row) => [
				row.id as string,
				Object.fromEntries(
					specs.map((spec) => [spec.name, toNumber(row[spec.name])]),
				),
			]),
		)
	}

	// How far the scenario took the portfolio beyond what the model has seen. A
	// stress test without this number is untrustworthy: ΔEL may be a property
	// not of risk but of the vector moving into a region where the model was
	// never trained and its answer is extrapolation.
	private async extrapolation(
		modelVersion: string,
		specs: FeatureSpec[],
		vectors: {
			base: { values: FeatureValues }[]
			stressed: { values: FeatureValues }[]
		},
	): Promise<Record<string, Extrapolation>> {
		if (specs.length === 0) return {}

		const model = await this.prisma.modelVersion.findUniqueOrThrow({
			where: { id: modelVersion },
			select: { quantiles: true },
		})
		const quantiles = (model.quantiles ?? {}) as Record<string, number>

		return Object.fromEntries(
			specs.map((spec) => {
				const p99 = quantiles[spec.name] ?? null
				const share = (rows: { values: FeatureValues }[]): number =>
					p99 === null || rows.length === 0
						? 0
						: rows.filter((v) => (v.values[spec.name] ?? -Infinity) > p99)
								.length / rows.length

				return [
					spec.name,
					{ p99, base: share(vectors.base), stressed: share(vectors.stressed) },
				]
			}),
		)
	}
}

function moved(base: FeatureValues, stressed?: FeatureValues): boolean {
	if (!stressed) return false
	return Object.entries(stressed).some(([name, value]) => base[name] !== value)
}

function toNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value)
}
