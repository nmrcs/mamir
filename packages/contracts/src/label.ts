import { z } from 'zod'
import { Slug } from './common'
import { FeatureWindow } from './feature'
import { Predicate } from './predicate'

// Definition of "loss" and the horizon over which the outcome becomes known.
//
// A label is a feature looking forward: the same window machinery as
// FeatureSpec, only with the opposite sign of time. Hence the built-in
// property — using the label at scoring time is impossible by construction,
// at time t the future does not exist yet. The horizon defines when the
// window closed and the label became known.
export const LabelSpec = z
	.object({
		// self    — the outcome is recorded in the event itself (card
		//           transaction: fraud or not); the horizon means only the
		//           confirmation delay;
		// forward — the outcome arrives later, in other events of the same
		//           entity (mortgage: the loan goes delinquent months after
		//           a payment).
		scope: z.enum(['self', 'forward']),
		// Required with scope: 'forward' — which entity to look forward along.
		entity: Slug.optional(),
		horizon: FeatureWindow,
		// Disjunctive normal form: OR between groups, AND within a group.
		// A single equality is not enough: "loss" in real domains is a set of
		// heterogeneous conditions (180+ days delinquent OR a removal code
		// from a given set).
		anyOf: z.array(z.array(Predicate).min(1)).min(1),
	})
	.refine((l) => l.scope !== 'forward' || l.entity !== undefined, {
		message: 'scope "forward" requires an entity axis',
		path: ['entity'],
	})
export type LabelSpec = z.infer<typeof LabelSpec>
