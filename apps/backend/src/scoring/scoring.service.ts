import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
// The fetch+Agent pair comes from ONE package deliberately: Node's built-in
// fetch carries its own copy of undici, and a dispatcher from the npm package
// does not fit it — the handler interfaces of the copies differ, and it fails
// on the very first call.
import { Agent, fetch as undiciFetch } from 'undici'
import {
	type FeatureValues,
	LossDistribution,
	type ScoreRequest,
	ScoreResponse,
} from '@mamir/contracts'
import type { Env } from '../config/env'
import { PrismaService } from '../prisma/prisma.service'

export interface EventScore {
	modelVersion: string
	raw: number
	probability: number
	latencyMs: number
}

// Scoring one event on intake. Separate from the backtest client, and that is
// not duplication: their requirements are opposite on every parameter a shared
// client would have to take as an argument. The backtest trains for minutes and
// must fail if scoring answered with an error; event intake lives for
// milliseconds and must survive the service being down. What they share is five
// lines of fetch.
@Injectable()
export class ScoringService {
	private readonly logger = new Logger(ScoringService.name)

	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<Env, true>,
	) {}

	async score(
		pluginId: string,
		eventId: string,
		values: FeatureValues,
	): Promise<EventScore | null> {
		const modelVersion = await this.latestVersion(pluginId)
		if (!modelVersion) {
			// A state, not an incident: the domain is plugged in, training has not
			// happened yet.
			this.logger.warn({
				actionCode: 'scoring.service.score.no_model',
				pluginId,
				eventId,
			})
			return null
		}

		const base = this.config.get('SCORING_URL', { infer: true })
		const startedAt = Date.now()

		try {
			const response = await fetch(`${base}/score`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// satisfies binds the body to the contract: a field that drifted
				// from the schema is caught by the compiler, not by a 422 from the
				// sidecar.
				body: JSON.stringify({
					modelVersion,
					vectors: [{ eventId, values }],
				} satisfies ScoreRequest),
				// The first request after a service restart unpacks the artifact
				// from disk, so the budget is measured from it, not from the
				// prediction.
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
			const latencyMs = Date.now() - startedAt

			if (!response.ok) {
				throw new Error(`${response.status}: ${await response.text()}`)
			}

			// Another service's response is a system boundary, and a schema is
			// mandatory here. The backtest casts the response with `as` and thereby
			// takes it on trust.
			const parsed = ScoreResponse.parse(await response.json())
			const [score] = parsed.scores

			this.logger.log({
				actionCode: 'scoring.service.score.completed',
				pluginId,
				eventId,
				modelVersion,
				latencyMs,
			})

			return {
				modelVersion,
				raw: score.raw,
				probability: score.probability,
				latencyMs,
			}
		} catch (error) {
			// The event has already been accepted, and intake must not be rolled
			// back because the sidecar is down: there would be nothing to restore
			// the domain fact from, while the score can be computed later from the
			// stored vector. Fail-open versus fail-closed is the caller's decision
			// — it sees score: null.
			this.logger.error({
				actionCode: 'scoring.service.score.error',
				pluginId,
				eventId,
				modelVersion,
				latencyMs: Date.now() - startedAt,
				message: (error as Error).message,
			})
			return null
		}
	}

	// Scoring a portfolio in batches. It differs from score not in size but in
	// behaviour on failure: event intake must survive a downed sidecar, an
	// exposure report must not. A portfolio computed without some of its
	// positions is not "a portfolio with gaps" but a wrong number, and staying
	// silent about it is not an option.
	async scoreAll(
		modelVersion: string,
		vectors: { eventId: string; values: FeatureValues }[],
	): Promise<Map<string, { raw: number; probability: number }>> {
		const base = this.config.get('SCORING_URL', { infer: true })
		const startedAt = Date.now()
		const scored = new Map<string, { raw: number; probability: number }>()

		for (let from = 0; from < vectors.length; from += BATCH) {
			const batch = vectors.slice(from, from + BATCH)
			const response = await fetch(`${base}/score`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					modelVersion,
					vectors: batch,
				} satisfies ScoreRequest),
			})

			if (!response.ok) {
				const detail = await response.text()
				this.logger.error({
					actionCode: 'scoring.service.scoreAll.error',
					modelVersion,
					batch: batch.length,
					status: response.status,
					detail,
				})
				throw new Error(`scoring returned ${response.status}: ${detail}`)
			}

			for (const score of ScoreResponse.parse(await response.json()).scores) {
				scored.set(score.eventId, {
					raw: score.raw,
					probability: score.probability,
				})
			}
		}

		// Another service's response is a boundary: the schema cannot express
		// "exactly as many scores as vectors", and a silent shortfall would turn
		// into a probability of zero for the reader and understate the portfolio
		// without a trace.
		if (scored.size !== vectors.length) {
			throw new Error(
				`scoring returned ${scored.size} scores for ${vectors.length} vectors`,
			)
		}

		this.logger.log({
			actionCode: 'scoring.service.scoreAll.completed',
			modelVersion,
			vectors: vectors.length,
			latencyMs: Date.now() - startedAt,
		})

		return scored
	}

	// The portfolio loss distribution. The core hands over ready probabilities
	// and amounts at risk, the sidecar draws the common factor: that is a
	// numerical task over arrays rather than data work, and doing it here would
	// mean dragging a random number generator into the core for one call.
	//
	// There are no domain words in the request — only numbers, model parameters
	// and, for a historical run, the realized loss: the percentile is computed on
	// the simulation side while the array of paths is still in memory.
	async distribution(input: {
		probability: number[]
		exposure: number[]
		severity: number
		correlation: number
		scenarios: number
		seed: number
		realized?: number
	}): Promise<LossDistribution> {
		const base = this.config.get('SCORING_URL', { infer: true })
		const startedAt = Date.now()

		// The sidecar answers only once the simulation is done, and by default
		// fetch waits no longer than five minutes for response headers — the path
		// ceiling would be three times below the one declared in the contract not
		// by decision but by transport default. The budget here and the scenarios
		// ceiling in the contract are derived from one measurement (~4×10⁷
		// position-paths per second) and travel as a pair.
		const response = await undiciFetch(`${base}/portfolio`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
			dispatcher: SIMULATION_AGENT,
		})

		if (!response.ok) {
			const detail = await response.text()
			this.logger.error({
				actionCode: 'scoring.service.distribution.error',
				positions: input.probability.length,
				status: response.status,
				detail,
			})
			throw new Error(`scoring returned ${response.status}: ${detail}`)
		}

		const distribution = LossDistribution.parse(await response.json())
		this.logger.log({
			actionCode: 'scoring.service.distribution.completed',
			positions: input.probability.length,
			scenarios: input.scenarios,
			rho: input.correlation,
			latencyMs: Date.now() - startedAt,
		})
		return distribution
	}

	// A version trained NO LATER than time t. The same point-in-time requirement
	// as for a feature, only addressed to the model: a January 2009 portfolio
	// evaluated by a model that has seen 2010 is a report from the future.
	//
	// The training boundary travels together with the identifier: "the model was
	// off by this much" is a different claim for a fresh model and for a
	// ten-year-old one, and a uuid alone does not show that.
	async versionAsOf(
		pluginId: string,
		at: Date,
	): Promise<{ id: string; trainWindowEnd: Date } | null> {
		const [version] = await this.prisma.modelVersion.findMany({
			where: { pluginId, trainWindowEnd: { lte: at } },
			orderBy: [{ trainWindowEnd: 'desc' }, { trainedAt: 'desc' }],
			take: 1,
			select: { id: true, trainWindowEnd: true },
		})
		return version ?? null
	}

	// The domain's latest trained version. There is no "production" flag on a
	// model — it would be a field without a reader; instead the model trained on
	// the freshest data is taken.
	//
	// The second sort key is not decoration: a repeated backtest run produces
	// versions with the same trainWindowEnd, and a tie here is the norm rather
	// than the exception.
	private async latestVersion(pluginId: string): Promise<string | null> {
		const [version] = await this.prisma.modelVersion.findMany({
			where: { pluginId },
			orderBy: [{ trainWindowEnd: 'desc' }, { trainedAt: 'desc' }],
			take: 1,
			select: { id: true },
		})
		return version?.id ?? null
	}
}

// The batch size for scoring a portfolio. The whole portfolio in one request
// body is hundreds of thousands of vectors in JSON, and on those the service
// runs into memory before it runs into the model.
const BATCH = 5000

const TIMEOUT_MS = 2000

// 200,000 paths on a portfolio of 200 thousand positions take ~17 minutes; 30
// minutes give twice the headroom. Zero (wait forever) will not do: a hung
// sidecar would hold the request indefinitely.
const SIMULATION_AGENT = new Agent({
	headersTimeout: 1_800_000,
	bodyTimeout: 1_800_000,
})
