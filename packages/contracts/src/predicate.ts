import { z } from 'zod'
import { Primitive } from './common'

// Predicate over an event field, implicit AND within an array. No eval —
// the core executes it with a fixed operation set. The set is exactly the
// operations declared by at least one domain: an operation without a reader
// extends the enum the day a reader appears, not before.
export const Predicate = z.object({
	field: z.string().min(1),
	op: z.enum(['eq', 'gte', 'in']),
	// Required: for every operation in the set a predicate without a value is
	// a typo, never a meaningful "any value".
	value: z.union([Primitive, z.array(Primitive)]),
})
export type Predicate = z.infer<typeof Predicate>
