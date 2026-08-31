import type {
	AmountSpec,
	EventSchema,
	TimeSpec,
	DomainPlugin,
} from '@mamir/contracts'
import { z } from 'zod'

type Payload = Record<string, unknown>

// The core builds the event validator from the plugin's declaration. The
// plugin brings neither a Zod schema nor a dependency — it stays data.
export function compilePayloadSchema(schema: EventSchema): z.ZodType<Payload> {
	const shape: Record<string, z.ZodTypeAny> = {}

	for (const [name, field] of Object.entries(schema)) {
		const base =
			field.type === 'string'
				? z.string()
				: field.type === 'number'
					? z.number()
					: z.boolean()

		shape[name] = field.required ? base : base.nullish()
	}

	// An undeclared field is not rejected, but not stored either. The first —
	// because the contract describes the interface between domain and
	// platform, not the source format: IEEE-CIS has 430+ columns, the 12 the
	// platform needs are declared. The second — because nothing can read it:
	// DomainPlugin requires every feature, label and scenario field to be
	// declared in event, so an undeclared field has no reader by
	// construction. On Freddie Mac this was 45% of payload volume across 26M
	// events.
	return z.object(shape)
}

// The event's moment. `seconds` is a relative scale: seconds from a
// reference point the domain does not declare, so absolute dates are
// meaningless. Point-in-time only needs monotonicity; in the UI such an
// axis is labeled with relative time, not an invented calendar.
export function extractOccurredAt(spec: TimeSpec, payload: Payload): Date {
	const value = Number(payload[spec.path])

	// A reporting period like 200704: balance-sheet domains have monthly
	// grain, the data has no day — take the first of the month.
	if (spec.unit === 'yyyymm') {
		const year = Math.floor(value / 100)
		const month = value % 100
		return new Date(Date.UTC(year, month - 1, 1))
	}

	return new Date(value * 1000)
}

// A string, not a number: downstream this is Decimal(18,4), and losing
// precision to floating-point arithmetic on money is unwelcome.
export function extractExposure(spec: AmountSpec, payload: Payload): string {
	return Number(payload[spec.path]).toFixed(4)
}

// Axes the exposure is aggregated along. An axis absent from the event
// (addr1 is optional) is simply missing — its features yield null, which is
// a valid value, not an error.
export function extractEntityKeys(
	entityKeys: DomainPlugin['entityKeys'],
	payload: Payload,
): Record<string, string> {
	const resolved: Record<string, string> = {}

	for (const [entity, path] of Object.entries(entityKeys)) {
		const value = payload[path]
		if (value !== null && value !== undefined && value !== '') {
			resolved[entity] = String(value)
		}
	}

	return resolved
}
