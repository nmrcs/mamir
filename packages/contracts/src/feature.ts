import { z } from 'zod'
import { Slug } from './common'
import { Predicate } from './predicate'

// Aggregate set — exactly those declared by at least one domain. Need a new
// one — extend the enum rather than open a loophole for arbitrary code.
export const FeatureAgg = z.enum([
	'count',
	'sum',
	'mean',
	'std',
	'min',
	'distinct',
	'time_since',
])
export type FeatureAgg = z.infer<typeof FeatureAgg>

// Aggregates that need an event field. count and time_since are computed
// over the entity's events themselves; they need no source.
export const AGGS_REQUIRING_SOURCE: readonly FeatureAgg[] = [
	'sum',
	'mean',
	'std',
	'min',
	'distinct',
]

// Aggregates that require a number specifically.
export const AGGS_REQUIRING_NUMBER: readonly FeatureAgg[] = [
	'sum',
	'mean',
	'std',
	'min',
]

export const FeatureWindow = z
	.string()
	.regex(/^[1-9]\d*[mhd]$/, "window like '30m' | '24h' | '7d'")

// A feature is a declaration, not a function. The only thing that computes
// it is the core, with the same windowed SQL in real-time and in backtest.
// No second code path exists, so train/serve skew is impossible by
// construction.
export const FeatureSpec = z
	.object({
		name: Slug,
		entity: Slug, // key from the plugin's entityKeys
		source: z.string().min(1).optional(), // payload path
		agg: FeatureAgg,
		window: FeatureWindow,
		// Which window events enter the aggregate, implicit AND. Without it
		// "months delinquent over a year" is inexpressible: count would tally
		// all of the loan's reporting records, not the delinquent ones, and
		// the feature would mean something other than its name claims.
		where: z.array(Predicate).default([]),
	})
	.refine((f) => !AGGS_REQUIRING_SOURCE.includes(f.agg) || f.source, {
		message: 'this aggregate requires a source',
		path: ['source'],
	})
	// "Time since the last event matching a condition" is a meaningful
	// quantity, and since the window form treats time_since as an aggregate,
	// nothing technical stands in its way. The pair is absent from the
	// contract because no domain has declared it: the core has no use for a
	// capability without a reader.
	.refine((f) => f.agg !== 'time_since' || f.where.length === 0, {
		message: 'where does not apply to time_since',
		path: ['where'],
	})
export type FeatureSpec = z.infer<typeof FeatureSpec>
