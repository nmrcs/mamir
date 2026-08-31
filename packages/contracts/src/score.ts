import { z } from 'zod'

// Contract with mamir-scoring. The service computes no features and touches
// no DB: it receives a ready vector and returns a probability. Features are
// computed by the core — a single code path for both training and scoring.
export const FeatureValues = z.record(z.string(), z.number().nullable())
export type FeatureValues = z.infer<typeof FeatureValues>

export const ScoreRequest = z.object({
	modelVersion: z.string().min(1),
	vectors: z
		.array(z.object({ eventId: z.uuid(), values: FeatureValues }))
		.min(1),
})
export type ScoreRequest = z.infer<typeof ScoreRequest>

export const ScoreResponse = z.object({
	// Non-empty: the request is non-empty too, and the reading side takes
	// scores[0]. The constraint lives in the contract, not in a defensive
	// check at the reader.
	scores: z
		.array(
			z.object({
				eventId: z.uuid(),
				// raw — before calibration, probability — after. Both are kept:
				// otherwise there is no way to see calibration doing anything.
				raw: z.number(),
				probability: z.number().min(0).max(1),
			}),
		)
		.min(1),
})
export type ScoreResponse = z.infer<typeof ScoreResponse>

// Portfolio loss distribution. The mean arrives twice: analytical (sum of
// probability × fraction × amount) and simulated. The gap between the two
// numbers is a built-in check that the simulation has not drifted from the
// formula — which is exactly why the second is not dropped as redundant.
export const LossDistribution = z.object({
	expectedLoss: z.number(),
	simulatedMean: z.number(),
	// Spread around the mean. Small with independent positions, large with a
	// common factor; the mean is the same either way.
	unexpectedLoss: z.number(),
	var99: z.number(),
	var999: z.number(),
	// Mean loss in the worst 2.5% of outcomes: "how bad it is when it's bad".
	es975: z.number(),
	max: z.number(),
	// Path count and correlation travel with the numbers: a quantile without
	// them is not a quantity but an opinion. Same rule as metrics carrying
	// their window and version.
	scenarios: z.number().int().positive(),
	rho: z.number().min(0).lt(1),
	// Where the actually realized loss landed, when known (historical run;
	// the "now" portfolio has nothing realized — null). The percentile is
	// exact, over the path array on the simulation side: computed outside
	// from the histogram it would carry a bin-width error.
	realized: z
		.object({ value: z.number(), percentile: z.number().min(0).max(1) })
		.nullable(),
	histogram: z.object({
		counts: z.array(z.number().int().nonnegative()),
		edges: z.array(z.number()),
	}),
})
export type LossDistribution = z.infer<typeof LossDistribution>
