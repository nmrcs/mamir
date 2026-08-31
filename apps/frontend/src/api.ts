import { useEffect, useState } from 'react'

// The core listens on 127.0.0.1:3001 and opens CORS to exactly :3000 — the
// showcase address and the core's allowed origin are already paired constants.
// No environment variable here: its reader would be a deploy that does not
// exist yet, and a deploy would have to change both sides at once anyway.
const BASE = 'http://localhost:3001'

// The shapes are read over HTTP, not imported from the core: the link here is
// a JSON contract, not shared code. A shared type would mean a build dependency
// of the showcase on the NestJS app for the sake of four interfaces.

export interface Plugin {
	id: string
	version: string
	entities: string[]
	features: string[]
	scenarios: string[]
	severity: number
}

export interface ReliabilityBin {
	bin: number
	from: number
	to: number
	count: number
	predicted: number
	observed: number
	kupiecLR: number
}

export interface Decile {
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

// Weighted Brier and ECE are optional not "just in case": runs made before
// they existed sit in the same table, and their metrics physically lack these
// keys. A zero instead of absence would assert a measurement that was never
// taken.
export interface Metrics {
	brier: number
	logLoss: number
	rocAuc: number
	prAuc: number
	ece: number
	positiveRate: number
	brierWeighted?: number
	eceWeighted?: number
}

export interface BacktestRun {
	id: string
	pluginId: string
	executionId: string | null
	window: { from: string; to: string }
	model: { id: string; trainWindowEnd: string; calibration: string }
	metrics: Metrics
	// Empty for the same early runs — the cut by exposure at risk was not
	// computed back then.
	reliability: ReliabilityBin[]
	deciles: Decile[]
	cases: number
	createdAt: string
}

export interface Case {
	name: string
	kind: string
	probability: number
	eventId: string
	occurredAt: string
	entityKeys: Record<string, string>
	exposure: string
	outcome: { value: boolean; resolvedAt: string } | null
	values: Record<string, number | null> | null
}

export interface ScenarioSpec {
	pluginId: string
	id: string
	title: string
	shock: { field: string; op: string; value: string | number | boolean }[]
}

export interface ScenarioRun {
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
	coverage: {
		scanned: number
		selected: number
		shocked: Record<string, number>
	}
	extrapolation: Record<
		string,
		{ p99: number | null; base: number; stressed: number }
	>
	createdAt: string
}

export interface HistorySpec {
	pluginId: string
	id: string
	title: string
	at: string
}

// The predicted loss distribution and where the realized loss falls in it. A
// percentile without the path count and correlation is an opinion, not a
// quantity, so rho and scenarios travel inside and are shown next to the
// numbers.
export interface LossDistribution {
	expectedLoss: number
	simulatedMean: number
	unexpectedLoss: number
	var99: number
	var999: number
	es975: number
	max: number
	scenarios: number
	rho: number
	realized: { value: number; percentile: number } | null
	histogram: { counts: number[]; edges: number[] }
}

export interface HistoryRun {
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
	// null — a run without the scenarios parameter: the simulation costs
	// minutes and is launched explicitly. This is a state, not missing data.
	distribution: LossDistribution | null
	createdAt: string
}

export interface Query<T> {
	data: T | null
	error: string | null
	loading: boolean
}

// `path === null` — no request yet: the cases screen does not know the window
// until one is picked. No separate "nothing to load" state — the same null in
// data conveys it.
export function useApi<T>(path: string | null): Query<T> {
	const [state, setState] = useState<Query<T>>({
		data: null,
		error: null,
		loading: path !== null,
	})

	useEffect(() => {
		if (path === null) {
			setState({ data: null, error: null, loading: false })
			return
		}

		// A cancelled request's response must not clobber a fresh one: switching
		// the plugin fires a second request before the first one returns.
		let alive = true
		setState({ data: null, error: null, loading: true })

		fetch(`${BASE}${path}`)
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`${response.status}: ${await response.text()}`)
				}
				return (await response.json()) as T
			})
			.then((data) => {
				if (alive) setState({ data, error: null, loading: false })
			})
			.catch((error: Error) => {
				if (alive) {
					setState({ data: null, error: error.message, loading: false })
				}
			})

		return () => {
			alive = false
		}
	}, [path])

	return state
}
