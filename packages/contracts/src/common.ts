import { z } from 'zod'

export const Slug = z
	.string()
	.regex(/^[a-z][a-z0-9_]*$/, 'slug must be lowercase snake_case')

// Event field value. JSON primitives only: the plugin contract must
// serialize (an npm package today, a DB row tomorrow).
export const Primitive = z.union([z.string(), z.number(), z.boolean()])
export type Primitive = z.infer<typeof Primitive>

export const FieldType = z.enum(['string', 'number', 'boolean'])
export type FieldType = z.infer<typeof FieldType>

export const EventField = z.object({
	type: FieldType,
	required: z.boolean().default(true),
})
export type EventField = z.infer<typeof EventField>

// Domain event schema as data, not a Zod object: the core builds the
// validator from it; the plugin ships no schemas and no dependencies.
export const EventSchema = z.record(z.string().min(1), EventField)
export type EventSchema = z.infer<typeof EventSchema>

// Event timestamp. Units are exactly those the domains declare:
//
// `seconds` — relative time from a zero point: in IEEE-CIS, TransactionDT
// is seconds from an unknown reference, not a date.
// `yyyymm` — a reporting period like 200704: balance-sheet domains have
// monthly granularity; there simply is no day in the data.
export const TimeSpec = z.object({
	path: z.string().min(1),
	unit: z.enum(['seconds', 'yyyymm']),
})
export type TimeSpec = z.infer<typeof TimeSpec>

// The amount at risk — and whether it is a stock or a flow. The distinction
// is not stylistic: it determines what the portfolio at time t even is.
//
// `entity` — a stock. The position is the entity; exposure is the value from
// its latest event. This is how a balance-sheet domain works: one loan has
// sixty monthly records, and summing them would count the portfolio
// sixty-fold.
//
// `event` — a flow. The position is the event itself: a transaction is
// instantaneous, "the card's latest value" is meaningless, while a sum over
// a window is not.
export const AmountSpec = z
	.object({
		path: z.string().min(1),
		position: z.enum(['entity', 'event']),
		// Axis the portfolio is collected by. Stock only: for a flow the
		// position is the event, there is nothing to fold along an axis.
		entity: Slug.optional(),
		// Fraction of the amount lost when the event occurs. Expected loss is
		// probability × fraction × amount, and without the third factor the
		// formula silently assumes one: "it happened — everything is lost".
		//
		// Required with no default, deliberately. Multiplying by one leaves
		// no trace in code or reports: an omitted factor is invisible, a
		// declared one must be stated out loud. A domain where the loss truly
		// is total writes 1 — but writes it.
		severity: z.number().positive().max(1),
	})
	.refine((a) => a.position !== 'entity' || a.entity, {
		message: 'a stock position requires an axis to collect the portfolio by',
		path: ['entity'],
	})
	.refine((a) => a.position !== 'event' || !a.entity, {
		message: 'a flow position is the event itself; an axis does not apply',
		path: ['entity'],
	})
export type AmountSpec = z.infer<typeof AmountSpec>
