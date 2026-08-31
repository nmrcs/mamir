import type { EventSchema } from '@mamir/contracts'

// CSV knows no types — everything arrives as strings, including empty cells
// in place of NaN. Coercion lives here and only here: past this point the
// event takes the same path as one arriving over HTTP, through the same
// validator and the same extractors. There is no second way to parse an
// event in the system.
//
// Only what the schema declares is collected. Source columns the domain did
// not declare go no further: a Freddie Mac row has 64 columns, the domain
// needs 23.
export function coerceRow(
	schema: EventSchema,
	row: Record<string, string>,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {}

	for (const [name, field] of Object.entries(schema)) {
		const raw = row[name]

		if (raw === undefined || raw === '') {
			payload[name] = field.required ? raw : null
			continue
		}

		payload[name] =
			field.type === 'number'
				? Number(raw)
				: field.type === 'boolean'
					? raw === 'True' || raw === 'true' || raw === '1'
					: raw
	}

	return payload
}
