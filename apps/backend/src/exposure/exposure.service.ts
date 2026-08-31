import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { FeatureValues } from '@mamir/contracts'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'
import { ScoringService } from '../scoring/scoring.service'
import { portfolioSql } from '../windows/window-sql'
import { expectedLoss } from './loss'

export interface PortfolioOptions {
	pluginId: string
	at: Date
	// How far back to look for a position. In effect: "a loan counts as
	// alive as long as records kept arriving for it" — without the bound the
	// portfolio would include every loan in history, including those paid
	// off twenty years ago.
	lookback: string
}

export interface Position {
	eventId: string
	entity: string
	exposure: number
	values: FeatureValues | null
	// How the position ended. `null` — no label at all; `matured: false` —
	// there is a label, but its horizon runs past the end of the data, and
	// the `false` recorded in it means "not yet", not "never".
	//
	// The reader is the historical run. A position without a matured outcome
	// must be dropped from BOTH sides of the comparison, not only from the
	// realized one.
	outcome: { value: boolean; matured: boolean } | null
}

export interface Slice {
	positions: number
	exposure: number
	expectedLoss: number
	// Share of the portfolio's expected loss falling on this slice.
	share: number
}

export interface ExposureReport {
	pluginId: string
	at: string
	lookback: string
	modelVersion: string
	positions: number
	exposure: number
	expectedLoss: number
	// Positions without a feature vector: the event exists, materialization
	// never ran. Printed next to the total, because a silently dropped part
	// of the portfolio makes EL understated, and the number alone does not
	// show it.
	withoutVector: number
	tail: Slice
	concentration: Slice
	elapsedMs: number
}

// Portfolio exposure as of moment t. The Aladdin-style layer: not "this
// loan is risky" but "this much of the portfolio is at risk, and here is
// where the risk is concentrated".
@Injectable()
export class ExposureService {
	private readonly logger = new Logger(ExposureService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
		private readonly scoring: ScoringService,
	) {}

	// Positions with their vectors. A separate method because scenario
	// stress takes the same portfolio and recomputes shocked features on it.
	async portfolio(options: PortfolioOptions): Promise<Position[]> {
		const plugin = this.registry.get(options.pluginId)

		const rows = await this.prisma.$queryRawUnsafe<
			{
				id: string
				entity: string
				exposure: number | null
				values: FeatureValues | null
				outcome: boolean | null
				matured: boolean | null
			}[]
		>(portfolioSql(plugin.id, plugin.exposure, options.lookback), options.at)

		return rows
			.filter((row) => row.exposure !== null && Number(row.exposure) > 0)
			.map((row) => ({
				eventId: row.id,
				entity: row.entity,
				exposure: Number(row.exposure),
				values: row.values,
				outcome:
					row.outcome === null
						? null
						: { value: row.outcome, matured: row.matured === true },
			}))
	}

	async report(
		options: PortfolioOptions & { top: number },
	): Promise<ExposureReport> {
		const startedAt = Date.now()
		const plugin = this.registry.get(options.pluginId)

		const model = await this.scoring.versionAsOf(plugin.id, options.at)
		if (!model) {
			this.logger.warn({
				actionCode: 'exposure.service.report.no_model',
				pluginId: plugin.id,
				at: options.at.toISOString(),
			})
			throw new NotFoundException(
				`plugin ${plugin.id} has no model trained by ${options.at.toISOString()}`,
			)
		}

		const positions = await this.portfolio(options)
		const scorable = positions.filter((p) => p.values !== null)

		const scored = await this.scoring.scoreAll(
			model.id,
			scorable.map((p) => ({ eventId: p.eventId, values: p.values! })),
		)

		// The loss share is declared by the domain: a loan has collateral, a
		// transaction does not. A position without a score contributes zero —
		// which is exactly why the count of such positions goes into the
		// report as its own line.
		const severity = plugin.exposure.severity
		const loss = (p: Position): number =>
			expectedLoss(
				scored.get(p.eventId)?.probability ?? 0,
				severity,
				p.exposure,
			)

		const exposure = positions.reduce((sum, p) => sum + p.exposure, 0)
		const total = positions.reduce((sum, p) => sum + loss(p), 0)

		// The tail — where the risk is concentrated. Sorted by contribution
		// to loss, not by probability: a position with probability 0.9 and a
		// thousand outstanding is no threat to the portfolio.
		const byLoss = [...positions].sort((a, b) => loss(b) - loss(a))
		const slice = (rows: Position[]): Slice => {
			const sliceLoss = rows.reduce((sum, p) => sum + loss(p), 0)
			return {
				positions: rows.length,
				exposure: rows.reduce((sum, p) => sum + p.exposure, 0),
				expectedLoss: sliceLoss,
				share: total ? sliceLoss / total : 0,
			}
		}

		const report: ExposureReport = {
			pluginId: plugin.id,
			at: options.at.toISOString(),
			lookback: options.lookback,
			modelVersion: model.id,
			positions: positions.length,
			exposure,
			expectedLoss: total,
			withoutVector: positions.length - scorable.length,
			tail: slice(byLoss.slice(0, Math.ceil(positions.length / 100))),
			concentration: slice(byLoss.slice(0, options.top)),
			elapsedMs: Date.now() - startedAt,
		}

		this.logger.log({
			actionCode: 'exposure.service.report.completed',
			...report,
		})

		return report
	}
}
