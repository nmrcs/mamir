import { z } from 'zod'
import { Slug } from './common'

// Event ingestion. The payload is validated against the plugin's schema in
// the core — this is only the envelope.
export const IngestEvent = z.object({
	pluginId: Slug,
	payload: z.record(z.string(), z.unknown()),
})
export type IngestEvent = z.infer<typeof IngestEvent>

export const IngestResult = z.object({
	eventId: z.uuid(),
	occurredAt: z.iso.datetime(),
	entityKeys: z.record(z.string(), z.string()),
	exposure: z.string(),
	// null means "the event is ACCEPTED but not scored": the domain has no
	// trained model yet, or scoring is unavailable. The feature vector is
	// still recorded, and the score is computed from it later. Rejecting
	// ingestion because a sidecar is down is not an option — the domain fact
	// cannot be reconstructed — and the fail-open/fail-closed decision
	// belongs to the caller: it sees a null, not silence.
	score: z
		.object({
			// A probability without a model version is not a number: two
			// versions give different answers on the same event.
			modelVersion: z.string().min(1),
			raw: z.number(),
			probability: z.number().min(0).max(1),
		})
		.nullable(),
})
export type IngestResult = z.infer<typeof IngestResult>
