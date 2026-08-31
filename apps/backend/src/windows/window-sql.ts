import type {
	AmountSpec,
	FeatureSpec,
	LabelSpec,
	Predicate,
	ScenarioSpec,
} from '@mamir/contracts'

// Compiler from declarations to SQL. One definition — two execution forms:
// pointwise (scoring a single event) and single-pass (training and backtest).
//
// The guarantee rests not on "there is one path" — nothing can verify that —
// but on both forms coming from one compiler, with their equivalence checked
// by a test. The measurement that forced two forms: 590k events for one
// feature — 28 minutes with pointwise queries vs 1.5 s in a single pass.

// ── window bounds ───────────────────────────────────────────────────────
//
// The bound is strictly `<` the current moment: simultaneous events must not
// see each other. Event order within one tick is arbitrary, and if they fall
// into each other's windows, the feature value depends on DB insertion order.
//
// This is expressed by the frame bounds THEMSELVES, not EXCLUDE GROUP, even
// though the latter describes the same row set. The reason is execution:
// Postgres computes a sliding aggregate incrementally (add the entering row,
// subtract the leaving one) only for a frame without EXCLUDE. With EXCLUDE
// the frame is recomputed from scratch on every row, and the cost becomes
// quadratic in frame size.
//
// Measured on one state (81k events, 365-day window): 20.3 s vs 0.147 s with
// an identical result. California has 29x more events, and with quadratic
// growth its windowed pass did not finish within half an hour.
//
// A one-microsecond step is finer than the storage granularity
// (`timestamp(3)`), so it excludes exactly the current row's same-instant
// peers and no one else.
const STRICTLY_BEFORE = `INTERVAL '1 microsecond' PRECEDING`
const STRICTLY_AFTER = `INTERVAL '1 microsecond' FOLLOWING`

function windowToInterval(window: string): string {
	const amount = window.slice(0, -1)
	const unit = window.slice(-1)
	const units: Record<string, string> = {
		m: 'minutes',
		h: 'hours',
		d: 'days',
	}
	return `INTERVAL '${Number(amount)} ${units[unit]}'`
}

// Chunking materialization into time slices was tried and rolled back: it
// is correct (verified — zero mismatches on 90,910 events) but three times
// slower. Twelve index scans with random heap access lose to one sequential
// pass.

function quote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function jsonText(field: string): string {
	return `payload->>${quote(field)}`
}

function numericOf(field: string): string {
	return `(CASE WHEN ${jsonText(field)} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${jsonText(field)})::numeric END)`
}

function predicateSql(p: Predicate): string {
	const text = jsonText(p.field)

	switch (p.op) {
		case 'eq':
			return `${text} = ${quote(String(p.value))}`
		case 'gte':
			return `${numericOf(p.field)} >= ${Number(p.value)}`
		case 'in': {
			const items = (Array.isArray(p.value) ? p.value : [p.value]).map((v) =>
				quote(String(v)),
			)
			return `${text} IN (${items.join(', ')})`
		}
	}
}

// Disjunctive normal form: OR between groups, AND within a group.
function anyOfSql(groups: Predicate[][]): string {
	return groups
		.map((group) => `(${group.map(predicateSql).join(' AND ')})`)
		.join(' OR ')
}

// ── features ────────────────────────────────────────────────────────────

function entityExpr(entity: string): string {
	return `"entityKeys"->>${quote(entity)}`
}

// ── projection for the sort ─────────────────────────────────────────────
//
// A window function requires a sort by (axis, time), and what gets sorted is
// exactly what the node below the plan handed up. If expressions over payload
// are computed in WindowAgg — which sits ABOVE the sort — the whole row
// travels through the sort, jsonb included.
//
// Measured on labelling: 26M events, 19 GB of temp files, 7 minutes. And all
// the window function needs from a row is the axis, the time and one boolean.
//
// So the compiler emits two stages: the inner one computes everything that
// depends on payload, the outer one works over scalars. `OFFSET 0` is an
// optimization barrier: without it Postgres pulls the subquery back up,
// inlines the expressions into WindowAgg, and the projection is lost.
function scan(
	pluginId: string,
	projections: string[],
	options: ScanOptions = {},
): string {
	// The source is substituted, the projections are not. That is the whole
	// point: a scenario hands over a table of the same shape with a modified
	// payload, and the compiler knows nothing about the shock. No second code
	// path appears for a feature, so a shocked vector is consistent with an
	// ordinary one by construction rather than by promise.
	const source = options.read ?? '"Event"'

	// The scan window. Without it the plugin's whole history is scanned —
	// that is how materialization works. A scenario needs no such thing: a
	// span covering the window of the longest recomputed feature is enough.
	const window = options.span
		? `\n    AND "ingestedAt" >= $1::timestamp - ${windowToInterval(options.span)}
    AND "ingestedAt" < $1::timestamp`
		: ''

	return `(
  SELECT ${projections.join(',\n         ')}
  FROM ${source}
  WHERE "pluginId" = ${quote(pluginId)}${window}
  OFFSET 0
)`
}

// The feature expression over a window frame. It references projection
// columns, not payload.
//
// `distinct` returns an ARRAY, not a number: Postgres does not accept
// count(DISTINCT ...) as a window function, and the array cannot be collapsed
// at this level — `unnest(array_agg(...) OVER w)` sits in FROM, where a window
// function is not allowed (42P20). So deduplication moves one level up, see
// bulkFeatureSql.
function bulkAgg(spec: FeatureSpec, i: number, frame: string): string {
	const src = `n${i}`
	const raw = `r${i}`

	// The window filter is FILTER on the aggregate, not WHERE in the query:
	// WHERE would drop the event from the result entirely, while it only needs
	// excluding from this one aggregate. The row has to stay — the other
	// features are computed from it. Not applied to time_since: the contract
	// forbids that pair, because it has no reader.
	const filter = spec.where.length ? ` FILTER (WHERE f${i})` : ''

	switch (spec.agg) {
		case 'count':
			return `count(*)${filter} OVER ${frame}`
		case 'sum':
			return `sum(${src})${filter} OVER ${frame}`
		case 'mean':
			return `avg(${src})${filter} OVER ${frame}`
		case 'std':
			return `stddev_samp(${src})${filter} OVER ${frame}`
		case 'min':
			return `min(${src})${filter} OVER ${frame}`
		case 'distinct':
			return `array_agg(${raw})${filter} OVER ${frame}`
		case 'time_since':
			// max over the frame, not lag. By the standard, lag ignores frame
			// bounds and takes the previous row of the partition — including a
			// row of the same timestamp as the current one. Of two events at
			// one moment the second got 0, and which one was "second" was
			// decided by arbitrary insertion order. The pointwise form cannot
			// do that: its window is set by WHERE, and same-moment rows never
			// enter it. max respects the frame, so the two forms agree by
			// construction.
			return `EXTRACT(EPOCH FROM ("ingestedAt" - max("ingestedAt") OVER ${frame}))`
	}
}

// What to read events from and within which bounds. Empty means the whole
// history from "Event", that is materialization; filled means a scenario
// recomputation.
export interface ScanOptions {
	// A source expression instead of "Event". Must yield the same columns.
	read?: string
	// The scan span: [$1 − span, $1).
	span?: string
}

// Form 1: a single pass over the plugin's whole history — for training and
// the backtest.
export function bulkFeatureSql(
	pluginId: string,
	specs: FeatureSpec[],
	options: ScanOptions = {},
): string {
	// Axes are numbered rather than substituted by name: an axis name is a
	// slug and may contain a hyphen, which a Postgres identifier may not.
	const entities = [...new Set(specs.map((s) => s.entity))]
	const alias = (entity: string): string => `e${entities.indexOf(entity)}`

	const projections = ['id', '"ingestedAt"']
	entities.forEach((entity) => {
		projections.push(`${entityExpr(entity)} AS ${alias(entity)}`)
	})

	specs.forEach((spec, i) => {
		if (spec.source) {
			projections.push(`${numericOf(spec.source)} AS n${i}`)
			if (spec.agg === 'distinct') {
				projections.push(`${jsonText(spec.source)} AS r${i}`)
			}
		}
		if (spec.where.length) {
			projections.push(
				`(${spec.where.map(predicateSql).join(' AND ')}) AS f${i}`,
			)
		}
	})

	// The CASE around the aggregate is not decoration. `PARTITION BY axis`
	// treats NULLs as EQUAL to each other, so every event without that axis
	// falls into one shared partition and they aggregate over each other:
	// "number of events for this address" on an event with no address becomes
	// a counter of all address-less events, that is a global volume dragged
	// inside a per-entity feature.
	//
	// The pointwise form (`WHERE axis = $1`) cannot do that — it returns null.
	// The forms diverged, and the equivalence test did not catch it: pairs
	// without an axis were skipped.
	const column = (spec: FeatureSpec): string =>
		quote(spec.name).replace(/'/g, '"')

	const windows = specs
		.map(
			(spec, i) =>
				`w${i} AS (PARTITION BY ${alias(spec.entity)} ORDER BY "ingestedAt" RANGE BETWEEN ${windowToInterval(spec.window)} PRECEDING AND ${STRICTLY_BEFORE})`,
		)
		.join(',\n       ')

	// `distinct` forces a third stage: the window level yields an array of the
	// window's values, and collapsing it into a number is only possible above —
	// inside the same SELECT a window function is forbidden in FROM. The stage
	// appears only when such a feature is declared: for a domain without
	// `distinct` the query shape stays as it was, and its plan was tuned by
	// measurement.
	if (specs.some((spec) => spec.agg === 'distinct')) {
		const inner = specs
			.map((spec, i) => `${bulkAgg(spec, i, `w${i}`)} AS v${i}`)
			.join(',\n         ')

		const outer = specs
			.map((spec, i) => {
				const value =
					spec.agg === 'distinct'
						? `(SELECT count(DISTINCT x) FROM unnest(v${i}) AS x)`
						: `v${i}`
				return `${nullWhenAxisMissing(alias(spec.entity), value)} AS ${column(spec)}`
			})
			.join(',\n       ')

		return `SELECT id,
       ${outer}
FROM (
  SELECT id,
         ${entities.map(alias).join(',\n         ')},
         ${inner}
  FROM ${scan(pluginId, projections, options)} s
  WINDOW ${windows}
) m`
	}

	const selects = specs
		.map(
			(spec, i) =>
				`${nullWhenAxisMissing(alias(spec.entity), bulkAgg(spec, i, `w${i}`))} AS ${column(spec)}`,
		)
		.join(',\n       ')

	return `SELECT id,
       ${selects}
FROM ${scan(pluginId, projections, options)} s
WINDOW ${windows}`
}

// `PARTITION BY axis` treats NULLs as EQUAL to each other, so every event
// without that axis falls into one shared partition and they aggregate over
// each other: "number of events for this address" on an event with no address
// becomes a counter of all address-less events, that is a global volume dragged
// inside a per-entity feature. The pointwise form (`WHERE axis = $1`) cannot do
// that — it returns null.
function nullWhenAxisMissing(axis: string, value: string): string {
	return `CASE WHEN ${axis} IS NULL THEN NULL ELSE ${value} END`
}

// Form 2: the value of one feature for one event — for real-time scoring.
// The `<` bound is the same one EXCLUDE GROUP gives in the windowed form.
export function pointFeatureSql(pluginId: string, spec: FeatureSpec): string {
	const src = spec.source ? numericOf(spec.source) : null
	const raw = spec.source ? jsonText(spec.source) : null

	const agg: Record<string, string> = {
		count: 'count(*)',
		sum: `sum(${src})`,
		mean: `avg(${src})`,
		std: `stddev_samp(${src})`,
		min: `min(${src})`,
		distinct: `count(DISTINCT ${raw})`,
		time_since: `EXTRACT(EPOCH FROM ($2::timestamp - max("ingestedAt")))`,
	}

	// Here the filter goes into WHERE rather than FILTER: the pointwise form
	// computes one feature, there are no extra rows in the result, and dropping
	// the event is safe.
	const where = spec.where.length
		? `\n  AND ${spec.where.map(predicateSql).join('\n  AND ')}`
		: ''

	return `SELECT ${agg[spec.agg]} AS value
FROM "Event"
WHERE "pluginId" = ${quote(pluginId)}
  AND ${entityExpr(spec.entity)} = $1
  AND "ingestedAt" >= $2::timestamp - ${windowToInterval(spec.window)}
  AND "ingestedAt" < $2::timestamp${where}`
}

// ── labels ──────────────────────────────────────────────────────────────

// A label is a feature that looks forward. The same window machinery with the
// sign of time reversed. Hence leakage is impossible by construction: at time t
// the future does not exist, so there is no label to use while scoring.
export function bulkLabelSql(pluginId: string, label: LabelSpec): string {
	const condition = anyOfSql(label.anyOf)
	const horizon = windowToInterval(label.horizon)

	if (label.scope === 'self') {
		return `SELECT id,
       (${condition}) AS value,
       "occurredAt" + ${horizon} AS resolved_at
FROM "Event"
WHERE "pluginId" = ${quote(pluginId)}`
	}

	const projections = [
		'id',
		'"ingestedAt"',
		`${entityExpr(label.entity ?? '')} AS e0`,
		`"occurredAt" + ${horizon} AS resolved_at`,
		`(${condition}) AS hit`,
	]

	// An event without an axis gets no forward label: there is no entity to
	// look forward along, and false would mean "there was no loss" without
	// grounds. This also closes the same hole as in features: PARTITION BY
	// treats NULLs as equal, and axis-less events would see each other's
	// "future".
	return `SELECT id,
       COALESCE(bool_or(hit) OVER w, false) AS value,
       resolved_at
FROM ${scan(pluginId, projections)} s
WHERE e0 IS NOT NULL
WINDOW w AS (PARTITION BY e0 ORDER BY "ingestedAt" RANGE BETWEEN ${STRICTLY_AFTER} AND ${horizon} FOLLOWING)`
}

// ── portfolio ───────────────────────────────────────────────────────────

// The portfolio as of time t is the set of positions with open exposure. What
// a position is is declared by the domain, and the whole query shape follows
// from it.
//
// Stock: a position is an entity, and exposure is taken from its LATEST event.
// Summing over events here would mean sixty records of one loan added up as
// sixty different debts.
//
// Flow: a position is the event itself. A transaction is instantaneous, there
// is nothing to collapse along an axis, and every event enters the portfolio
// with its own amount.
//
// The moment is parameter $1. The bound is strict, as in a feature window: the
// portfolio at t is assembled from what was known BEFORE t.
export function positionSql(
	pluginId: string,
	exposure: AmountSpec,
	lookback: string,
	read?: string,
): string {
	// An ordinary portfolio takes the ready column: `path` was applied when the
	// event was accepted, and parsing jsonb again would mean a second source
	// for one quantity.
	//
	// Under a shock it is the opposite, payload only. The shocked field may be
	// the exposure field: on a flow domain what is at risk is the amount of the
	// transaction itself. Keeping the column would mean computing ΔEL with the
	// amount at risk unchanged — counting the shift in probability and losing
	// the shift in amount. On a balance-sheet domain this never shows: there
	// the rate and LTV are shocked, while exposure is the outstanding balance.
	const amount = read ? numericOf(exposure.path) : `exposure`
	const bounds = `"pluginId" = ${quote(pluginId)}
    AND "ingestedAt" >= $1::timestamp - ${windowToInterval(lookback)}
    AND "ingestedAt" < $1::timestamp`

	const source = read ?? '"Event"'

	if (exposure.position === 'event') {
		return `SELECT id, id::text AS entity, ${amount} AS exposure
FROM ${source}
WHERE ${bounds}`
	}

	const axis = entityExpr(exposure.entity as string)

	// The ordering has to be total: DISTINCT ON takes the first row of a group,
	// and with equal ingestedAt "first" would be decided by read order. That is
	// exactly what broke the reproducibility of the extract — id as a second
	// key closes the same hole here.
	return `SELECT DISTINCT ON (${axis}) id, ${axis} AS entity, ${amount} AS exposure
FROM ${source}
WHERE ${bounds}
  AND ${axis} IS NOT NULL
ORDER BY ${axis}, "ingestedAt" DESC, id DESC`
}

// The whole portfolio: a position, its vector as of the event, and its outcome.
//
// In one query rather than three: assembling positions is the expensive part,
// while the vector and the label are reached by primary key. A separate pass
// for one column would cost as much as the entire portfolio.
//
// `matured` answers whether we know the outcome. A label always lives in the
// table, but its `false` before the horizon expires means "has not happened
// yet", not "will not happen"; telling one from the other is only possible by
// comparing the maturation date with the end of the data.
export function portfolioSql(
	pluginId: string,
	exposure: AmountSpec,
	lookback: string,
): string {
	return `SELECT p.id, p.entity, p.exposure, v.values,
       l.value AS outcome,
       l."resolvedAt" <= (
         SELECT max("ingestedAt") FROM "Event" WHERE "pluginId" = ${quote(pluginId)}
       ) AS matured
FROM (${positionSql(pluginId, exposure, lookback)}) p
LEFT JOIN "FeatureVector" v ON v."eventId" = p.id
LEFT JOIN "Label" l ON l."eventId" = p.id`
}

// ── scenario shock ──────────────────────────────────────────────────────

// A source of events with substituted field values. It yields the same shape
// as "Event", so the feature compiler knows nothing about the shock and no
// second code path appears for a feature.
//
// What is shocked is an event FIELD, not a computed feature. Features cannot be
// moved individually: several are derived from one field, and an independent
// shift produces a vector inconsistent with itself. Here consistency is
// constructive — the field changed, and every derivative was recomputed by the
// same code.
export function shockReader(scenario: ScenarioSpec): string {
	const selected = scenario.select.length
		? scenario.select.map(predicateSql).join(' AND ')
		: 'true'

	const patch = scenario.shock
		.map(
			(shock) =>
				`${quote(shock.field)}, to_jsonb(${numericOf(shock.field)} ${shock.op === 'mul' ? '*' : '+'} ${shock.value})`,
		)
		.join(',\n             ')

	return `(
  SELECT id, "pluginId", "entityKeys", "occurredAt", "ingestedAt", exposure,
         CASE WHEN ${selected}
              THEN payload || jsonb_build_object(
             ${patch}
           )
              ELSE payload
         END AS payload
  FROM "Event"
)`
}

// How many rows the shock actually touched. Without this number ΔEL is
// uninterpretable: "the portfolio is resilient" and "the shock reached no row
// at all" give the same zero, and only this tells them apart.
//
// A field absent from the events gives `shocked = 0` with a non-empty
// `selected` — the scenario picked positions, but there was nothing in them to
// change.
export function shockCoverageSql(
	pluginId: string,
	scenario: ScenarioSpec,
	span: string,
): string {
	const selected = scenario.select.length
		? scenario.select.map(predicateSql).join(' AND ')
		: 'true'

	const columns = scenario.shock
		.map(
			(shock, i) =>
				`count(*) FILTER (WHERE (${selected}) AND ${numericOf(shock.field)} IS NOT NULL)::int AS shocked${i}`,
		)
		.join(',\n       ')

	return `SELECT count(*)::int AS scanned,
       count(*) FILTER (WHERE ${selected})::int AS selected,
       ${columns}
FROM "Event"
WHERE "pluginId" = ${quote(pluginId)}
  AND "ingestedAt" >= $1::timestamp - ${windowToInterval(span)}
  AND "ingestedAt" < $1::timestamp`
}

// The longest of the windows — how much history to capture so that a
// recomputation as of time t is complete.
export function longestWindow(windows: string[]): string {
	return windows.reduce((longest, window) =>
		windowMs(window) > windowMs(longest) ? window : longest,
	)
}

export function windowMs(window: string): number {
	const amount = Number(window.slice(0, -1))
	const unit = window.slice(-1)
	const ms: Record<string, number> = {
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	}
	return amount * ms[unit]
}
