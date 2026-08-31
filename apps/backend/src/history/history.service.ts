import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { LossDistribution } from '@mamir/contracts'
import { ExposureService, type Position } from '../exposure/exposure.service'
import { expectedLoss, realizedLoss } from '../exposure/loss'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'
import { ScoringService } from '../scoring/scoring.service'

export interface HistoryOptions {
	pluginId: string
	scenarioId: string
	lookback: string
	// The number of simulation paths for the loss distribution; without it the
	// distribution is not computed — the simulation costs minutes on top of
	// assembling the portfolio.
	scenarios?: number
	seed: number
	// A correlation override FOR ONE RUN. The default is declared by the domain,
	// but ρ is the least reliable parameter in the system (our own estimate
	// swings fivefold with the window), and a conclusion that flips inside that
	// band must not be published as a single point. The value used travels in
	// the report (`distribution.rho`) and is stored with the run.
	rho?: number
}

export interface HistoryReport {
	runId: string
	pluginId: string
	scenarioId: string
	title: string
	at: string
	lookback: string
	modelVersion: string
	trainedTo: string
	positions: number
	compared: number
	exposure: number
	predictedEL: number
	realizedLoss: number
	// By what factor the realized diverged from the predicted. One means the
	// model named the scale of losses correctly, less means it overstated, more
	// means it slept through.
	ratio: number
	expectedPositives: number
	observedPositives: number
	withoutVector: number
	withoutLabel: number
	unmatured: number
	// A cut of the portfolio by amount at risk. The overall ratio of realized to
	// predicted says "the model was off by this factor" but does not say where;
	// average metrics will never say it, because they are computed over events
	// without weight.
	deciles: Decile[]
	// The predicted loss distribution and where the realized loss falls in it.
	// The realized/predictedEL ratio says "by what factor we were off", the
	// percentile says "was such an outcome in the support at all": with
	// independent positions a threefold miss lies a hundred sigma out, with
	// correlated ones it lies in a bad but describable tail.
	distribution: LossDistribution | null
	elapsedMs: number
}

// type, not interface: Prisma accepts only structures with an index signature
// into Json.
export type Decile = {
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

// A stored run. There is no episode title here: it lives in the plugin
// declaration and is served by `GET /history`. A copy would drift from the
// original on the first edit of the text.
export interface HistoryRunView {
	id: string
	pluginId: string
	scenarioId: string
	at: string
	lookback: string
	modelVersion: string
	trainedTo: string
	positions: number
	compared: number
	exposure: number
	predictedEL: number
	realizedLoss: number
	ratio: number
	expectedPositives: number
	observedPositives: number
	withoutVector: number
	withoutLabel: number
	unmatured: number
	deciles: Decile[]
	distribution: LossDistribution | null
	createdAt: string
}

// A historical run. A hypothetical scenario answers "the model says this
// much", this one answers "the model said this much, and this much came out".
//
// The moment comes from the declaration, not from the request: this is a named
// episode of the domain, not an arbitrary date. The realization window is not
// specified at all — it is set by the label horizon, and there is no other
// honest option: the probability predicts an outcome over exactly that
// horizon.
@Injectable()
export class HistoryService {
	private readonly logger = new Logger(HistoryService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
		private readonly exposure: ExposureService,
		private readonly scoring: ScoringService,
	) {}

	async run(options: HistoryOptions): Promise<HistoryReport> {
		const startedAt = Date.now()
		const plugin = this.registry.get(options.pluginId)
		const episode = plugin.history.find((h) => h.id === options.scenarioId)

		if (!episode) {
			throw new NotFoundException(
				`plugin ${plugin.id} has no historical episode "${options.scenarioId}"`,
			)
		}

		const at = new Date(episode.at)
		const model = await this.scoring.versionAsOf(plugin.id, at)
		if (!model) {
			throw new NotFoundException(
				`plugin ${plugin.id} has no model trained by ${episode.at}`,
			)
		}

		const positions = await this.exposure.portfolio({
			pluginId: plugin.id,
			at,
			lookback: options.lookback,
		})

		// Only positions that have both sides can be compared: a vector, so the
		// model can name its number, and a matured label, so there is something
		// to compare against. Computing the prediction over one set and the
		// realization over another means comparing different portfolios: an
		// immature label sits at `false`, and including it silently would
		// understate the realized side.
		const compared = positions.filter(
			(p) => p.values !== null && p.outcome?.matured === true,
		)

		const scored = await this.scoring.scoreAll(
			model.id,
			compared.map((p) => ({ eventId: p.eventId, values: p.values! })),
		)
		// No fallback value: scoreAll throws if fewer scores arrived than
		// vectors, so a shortfall is impossible here, and `?? 0` would disguise it
		// as a "safe position".
		const probability = (p: Position): number =>
			scored.get(p.eventId)!.probability

		// Loss given default enters both sides of the comparison. The predicted
		// side without it would mean "a default takes the whole balance", the
		// realized side the same about defaults that happened. A common
		// multiplier does not change the gap between the sides, but each side on
		// its own stops being a fiction.
		const severity = plugin.exposure.severity
		const predictedEL = compared.reduce(
			(sum, p) => sum + expectedLoss(probability(p), severity, p.exposure),
			0,
		)
		const realized = compared.reduce(
			(sum, p) => sum + realizedLoss(p.outcome!.value, severity, p.exposure),
			0,
		)

		// The distribution is computed over THE SAME compared set as both sides
		// of the comparison: the percentile of a realized loss within the
		// distribution of a different portfolio would be comparing apples to
		// oranges.
		const distribution =
			options.scenarios === undefined
				? null
				: await this.scoring.distribution({
						probability: compared.map((p) => probability(p)),
						exposure: compared.map((p) => p.exposure),
						severity,
						correlation: options.rho ?? plugin.correlation,
						scenarios: options.scenarios,
						seed: options.seed,
						realized,
					})

		const report = {
			pluginId: plugin.id,
			scenarioId: episode.id,
			title: episode.title,
			at: episode.at,
			lookback: options.lookback,
			modelVersion: model.id,
			trainedTo: model.trainWindowEnd.toISOString(),
			positions: positions.length,
			compared: compared.length,
			exposure: compared.reduce((sum, p) => sum + p.exposure, 0),
			predictedEL,
			realizedLoss: realized,
			ratio: predictedEL ? realized / predictedEL : 0,
			// The same comparison in counts. Money and counts diverge when the
			// model got who right but not how large the positions were, and vice
			// versa.
			expectedPositives: compared.reduce((sum, p) => sum + probability(p), 0),
			observedPositives: compared.filter((p) => p.outcome!.value).length,
			withoutVector: positions.filter((p) => p.values === null).length,
			withoutLabel: positions.filter((p) => p.outcome === null).length,
			unmatured: positions.filter((p) => p.outcome?.matured === false).length,
			deciles: deciles(compared, probability, severity),
			distribution,
			elapsedMs: Date.now() - startedAt,
		}

		const run = await this.prisma.historicalRun.create({
			data: {
				pluginId: report.pluginId,
				scenarioId: report.scenarioId,
				asOf: at,
				lookback: report.lookback,
				modelVersionId: report.modelVersion,
				trainedTo: model.trainWindowEnd,
				positions: report.positions,
				compared: report.compared,
				exposure: report.exposure,
				predictedEL: report.predictedEL,
				realizedLoss: report.realizedLoss,
				expectedPositives: report.expectedPositives,
				observedPositives: report.observedPositives,
				withoutVector: report.withoutVector,
				withoutLabel: report.withoutLabel,
				unmatured: report.unmatured,
				deciles: report.deciles,
				distribution: report.distribution ?? undefined,
			},
			select: { id: true },
		})

		// A run with nothing left to compare is not "zero error" but a run that
		// did not happen: that is what an episode declared on a date where the
		// labels have not matured looks like.
		this.logger[report.compared === 0 ? 'warn' : 'log']({
			actionCode: `history.service.run.${report.compared === 0 ? 'nothing_to_compare' : 'completed'}`,
			runId: run.id,
			...report,
		})

		return { runId: run.id, ...report }
	}

	// Stored runs. A portfolio on a balance-sheet domain takes two minutes to
	// assemble, and that cannot be the response to opening a page.
	async runs(pluginId?: string): Promise<HistoryRunView[]> {
		const runs = await this.prisma.historicalRun.findMany({
			where: pluginId ? { pluginId } : {},
			orderBy: { createdAt: 'desc' },
		})

		return runs.map((run) => {
			const predictedEL = Number(run.predictedEL)
			const realizedLoss = Number(run.realizedLoss)

			return {
				id: run.id,
				pluginId: run.pluginId,
				scenarioId: run.scenarioId,
				at: run.asOf.toISOString(),
				lookback: run.lookback,
				modelVersion: run.modelVersionId,
				trainedTo: run.trainedTo.toISOString(),
				positions: run.positions,
				compared: run.compared,
				exposure: Number(run.exposure),
				predictedEL,
				realizedLoss,
				ratio: predictedEL ? realizedLoss / predictedEL : 0,
				expectedPositives: run.expectedPositives,
				observedPositives: run.observedPositives,
				withoutVector: run.withoutVector,
				withoutLabel: run.withoutLabel,
				unmatured: run.unmatured,
				deciles: run.deciles as Decile[],
				distribution: (run.distribution as LossDistribution | null) ?? null,
				createdAt: run.createdAt.toISOString(),
			}
		})
	}
}

// A cut of the portfolio by amount at risk: groups of equal position count,
// ordered by exposure. Equal in count rather than in money — otherwise the top
// group would consist of a dozen loans, and the observed frequency in it would
// be noise rather than a measurement.
const GROUPS = 10

function deciles(
	positions: Position[],
	probability: (position: Position) => number,
	severity: number,
): Decile[] {
	const sorted = [...positions].sort((a, b) => a.exposure - b.exposure)
	const size = Math.floor(sorted.length / GROUPS)
	if (size === 0) return []

	return Array.from({ length: GROUPS }, (_, g) => {
		const group = sorted.slice(
			g * size,
			g === GROUPS - 1 ? sorted.length : (g + 1) * size,
		)
		const sum = (of: (position: Position) => number): number =>
			group.reduce((total, position) => total + of(position), 0)

		return {
			decile: g + 1,
			from: group[0].exposure,
			to: group[group.length - 1].exposure,
			count: group.length,
			exposure: sum((position) => position.exposure),
			predicted: sum(probability) / group.length,
			observed:
				group.filter((position) => position.outcome!.value).length /
				group.length,
			predictedLoss: sum((position) =>
				expectedLoss(probability(position), severity, position.exposure),
			),
			realizedLoss: sum((position) =>
				realizedLoss(position.outcome!.value, severity, position.exposure),
			),
		}
	})
}
