import { z } from 'zod'
import { Slug } from './common'
import { Predicate } from './predicate'

// Shock to an observable quantity: an event field changes, not a value
// derived from it.
//
// Computed features cannot be moved individually — several features may be
// computed from one field, and shifting them independently yields a vector
// inconsistent with itself (20x more transactions, mean ticket 5, yet the
// daily sum unchanged). A field shock is recomputed by the same window
// compiler that computes features in training and scoring, so consistency
// holds by construction.
export const FieldShock = z.object({
	field: z.string().min(1), // field from event
	op: z.enum(['mul', 'add']),
	value: z.number(),
})
export type FieldShock = z.infer<typeof FieldShock>

// Stress scenario: whom to shock (select — by event fields) and what to
// change in their events. The core recomputes features on the shocked values
// and compares expected losses against the baseline.
export const ScenarioSpec = z.object({
	id: Slug,
	title: z.string().min(1),
	select: z.array(Predicate).default([]), // empty = whole portfolio
	shock: z.array(FieldShock).min(1),
})
export type ScenarioSpec = z.infer<typeof ScenarioSpec>

// Historical scenario: not "what if" but "what was". It requires no shock at
// all — the shift already happened and sits in the data.
//
// The difference from a hypothetical one is not mechanics but the question a
// run answers. A hypothetical says "the model thinks the portfolio would
// lose this much". A historical says "the model predicted this much, and
// this much was actually lost" — and it is what feeds the misses section.
//
// The realization window is deliberately not declared here: the label's
// horizon sets it. Allow choosing it separately, and realized losses would
// be counted over a period the probability does not predict.
export const HistoricalSpec = z.object({
	id: Slug,
	title: z.string().min(1),
	// The moment the portfolio is collected at. The domain knows which of
	// its dates are interesting; the core does not.
	at: z.iso.datetime(),
})
export type HistoricalSpec = z.infer<typeof HistoricalSpec>
