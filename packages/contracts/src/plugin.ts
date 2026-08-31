import { z } from 'zod'
import { AmountSpec, EventSchema, Slug, TimeSpec } from './common'
import { AGGS_REQUIRING_NUMBER, FeatureSpec } from './feature'
import { LabelSpec } from './label'
import { HistoricalSpec, ScenarioSpec } from './scenario'

// A plugin is data, not code. Not a single executable expression: what asked
// to be a function (entityKey(e), occurredAt(e), exposure(e)) is declared as
// a path into the payload. Otherwise the contract validates only halfway —
// z.custom<(e) => Date>() checks nothing at runtime.
const DomainPluginObject = z.object({
	id: Slug,
	version: z.string().min(1),
	event: EventSchema,
	entityKeys: z.record(Slug, z.string().min(1)), // aggregation axis → payload path
	occurredAt: TimeSpec,
	exposure: AmountSpec,
	// How correlated position outcomes are. Zero — independent, and the
	// portfolio adds up as a sum of independent events; above zero — there is
	// a common factor, the loss distribution's tail thickens, and the mean
	// does not change.
	//
	// Required with no default for the same reason as severity: a zero taken
	// silently is the claim "systemic risk does not exist" that nobody made
	// out loud. A domain where there truly is no correlation writes 0 — but
	// writes it.
	//
	// The upper bound is strict: at ρ = 1 all positions become one, and the
	// portfolio stops being a portfolio.
	correlation: z.number().min(0).lt(1),
	features: z.array(FeatureSpec).min(1),
	label: LabelSpec,
	scenarios: z.array(ScenarioSpec).default([]),
	history: z.array(HistoricalSpec).default([]),
})

// Cross-references inside the plugin. A typo in a feature name or axis fails
// at core startup, not two hours into a backtest.
export const DomainPlugin = DomainPluginObject.superRefine((plugin, ctx) => {
	const fields = plugin.event
	const entities = new Set(Object.keys(plugin.entityKeys))

	const requireField = (
		path: (string | number)[],
		value: string,
		type?: 'string' | 'number' | 'boolean',
	): void => {
		const field = fields[value]
		if (!field) {
			ctx.addIssue({
				code: 'custom',
				path,
				message: `field "${value}" is not declared in event`,
			})
			return
		}
		if (type && field.type !== type) {
			ctx.addIssue({
				code: 'custom',
				path,
				message: `field "${value}" must be ${type}, declared as ${field.type}`,
			})
		}
	}

	for (const [entity, path] of Object.entries(plugin.entityKeys)) {
		requireField(['entityKeys', entity], path)
	}

	requireField(['occurredAt', 'path'], plugin.occurredAt.path, 'number')
	requireField(['exposure', 'path'], plugin.exposure.path, 'number')

	if (plugin.exposure.entity && !entities.has(plugin.exposure.entity)) {
		ctx.addIssue({
			code: 'custom',
			path: ['exposure', 'entity'],
			message: `axis "${plugin.exposure.entity}" is not in entityKeys`,
		})
	}

	if (plugin.label.entity && !entities.has(plugin.label.entity)) {
		ctx.addIssue({
			code: 'custom',
			path: ['label', 'entity'],
			message: `axis "${plugin.label.entity}" is not in entityKeys`,
		})
	}
	plugin.label.anyOf.forEach((group, i) => {
		group.forEach((predicate, j) => {
			requireField(['label', 'anyOf', i, j, 'field'], predicate.field)
		})
	})

	plugin.features.forEach((feature, i) => {
		if (!entities.has(feature.entity)) {
			ctx.addIssue({
				code: 'custom',
				path: ['features', i, 'entity'],
				message: `axis "${feature.entity}" is not in entityKeys`,
			})
		}
		if (feature.source) {
			requireField(
				['features', i, 'source'],
				feature.source,
				AGGS_REQUIRING_NUMBER.includes(feature.agg) ? 'number' : undefined,
			)
		}
		feature.where.forEach((predicate, j) => {
			requireField(['features', i, 'where', j, 'field'], predicate.field)
		})
	})

	plugin.scenarios.forEach((scenario, i) => {
		scenario.shock.forEach((shock, j) => {
			requireField(['scenarios', i, 'shock', j, 'field'], shock.field, 'number')
		})
		scenario.select.forEach((predicate, j) => {
			requireField(['scenarios', i, 'select', j, 'field'], predicate.field)
		})
	})

	reportDuplicates(
		ctx,
		plugin.features.map((f) => f.name),
		'features',
		'name',
	)
	reportDuplicates(
		ctx,
		plugin.scenarios.map((s) => s.id),
		'scenarios',
		'id',
	)
	reportDuplicates(
		ctx,
		plugin.history.map((h) => h.id),
		'history',
		'id',
	)
})
export type DomainPlugin = z.infer<typeof DomainPlugin>

// Type for authoring a plugin: defaults (`required`, `select`) are not yet
// applied, hence optional. Plugins declare themselves as
// `satisfies DomainPluginInput`; the core receives a DomainPlugin.
export type DomainPluginInput = z.input<typeof DomainPlugin>

function reportDuplicates(
	ctx: z.RefinementCtx,
	values: string[],
	collection: string,
	key: string,
): void {
	const seen = new Set<string>()
	values.forEach((value, i) => {
		if (seen.has(value)) {
			ctx.addIssue({
				code: 'custom',
				path: [collection, i, key],
				message: `duplicate "${value}"`,
			})
		}
		seen.add(value)
	})
}
