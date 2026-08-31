import { Injectable, Logger } from '@nestjs/common'
import type { FeatureValues } from '@mamir/contracts'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'
import { bulkFeatureSql, bulkLabelSql, pointFeatureSql } from './window-sql'

export interface MaterializeReport {
	rows: number
	elapsedMs: number
}

export interface Mismatch {
	feature: string
	eventId: string
	at: string
	bulk: number | null
	point: number | null
}

export interface EquivalenceReport {
	events: number
	checked: number
	mismatches: number
	byFeature: Record<string, number>
	examples: Mismatch[]
	elapsedMs: number
}

interface SampledEvent {
	id: string
	ingestedAt: Date
	entityKeys: Record<string, string>
	values: Record<string, unknown>
}

function toNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value)
}

// Both forms compute the same thing in numeric, but through different plans,
// so the last bit of the mantissa may differ. A substantive mismatch means a
// different set of rows in the window, and that is orders of magnitude larger
// than a relative 1e-9.
function same(bulk: number | null, point: number | null): boolean {
	if (bulk === null || point === null) {
		return bulk === point
	}
	const scale = Math.max(Math.abs(bulk), Math.abs(point), 1)
	return Math.abs(bulk - point) / scale < 1e-9
}

@Injectable()
export class WindowsService {
	private readonly logger = new Logger(WindowsService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
	) {}

	// Indexes are derived from the axes declared by the plugin — the same way
	// window SQL is. The core does not know an axis is called "loan": it knows
	// every axis takes part in PARTITION BY and in the pointwise form's filter,
	// and builds a partial index on (axis, time) for that.
	async ensureIndexes(pluginId: string): Promise<string[]> {
		const plugin = this.registry.get(pluginId)
		const created: string[] = []

		for (const entity of Object.keys(plugin.entityKeys)) {
			const name = `Event_${plugin.id}_${entity}_idx`
			await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "${name}"
        ON "Event" (("entityKeys"->>'${entity}'), "ingestedAt")
        WHERE "pluginId" = '${plugin.id}'
      `)
			created.push(name)
		}

		this.logger.log({
			actionCode: 'windows.service.ensureIndexes.ready',
			pluginId,
			indexes: created,
		})

		return created
	}

	// Materialization runs as INSERT … SELECT inside Postgres: pushing 26M rows
	// through Node only to put them back is pointless.
	async materializeFeatures(pluginId: string): Promise<MaterializeReport> {
		const plugin = this.registry.get(pluginId)
		const jsonPairs = plugin.features
			.map((f) => `'${f.name}', to_jsonb(f."${f.name}")`)
			.join(',\n            ')

		return this.run(
			'features',
			pluginId,
			`
      INSERT INTO "FeatureVector" (id, "eventId", "computedAt", values)
      SELECT uuidv7(), f.id, now(),
             jsonb_build_object(
            ${jsonPairs}
             )
      FROM (${bulkFeatureSql(pluginId, plugin.features)}) f
      ON CONFLICT ("eventId") DO UPDATE SET values = EXCLUDED.values, "computedAt" = now()
    `,
		)
	}

	async materializeLabels(pluginId: string): Promise<MaterializeReport> {
		const plugin = this.registry.get(pluginId)

		return this.run(
			'labels',
			pluginId,
			`
      INSERT INTO "Label" ("eventId", value, "resolvedAt")
      SELECT l.id, l.value, l.resolved_at
      FROM (${bulkLabelSql(pluginId, plugin.label)}) l
      ON CONFLICT ("eventId") DO UPDATE SET value = EXCLUDED.value, "resolvedAt" = EXCLUDED."resolvedAt"
    `,
		)
	}

	// The pointwise form — the one that runs during real-time scoring. Also used
	// by the equivalence test against the windowed form.
	async pointFeature(
		pluginId: string,
		featureName: string,
		entityValue: string,
		at: Date,
	): Promise<number | null> {
		const plugin = this.registry.get(pluginId)
		const spec = plugin.features.find((f) => f.name === featureName)
		if (!spec) {
			throw new Error(`plugin "${pluginId}" has no feature "${featureName}"`)
		}

		const rows = await this.prisma.$queryRawUnsafe<{ value: number | null }[]>(
			pointFeatureSql(pluginId, spec),
			entityValue,
			at,
		)
		const value = rows[0]?.value
		return value === undefined || value === null ? null : Number(value)
	}

	// The feature vector of one event — what goes into the model during
	// real-time scoring. Assembled from the same pointwise queries whose
	// equivalence to the windowed form verifyEquivalence checks: no third form
	// is introduced, or production would run code checked against nothing.
	//
	// Promise.all rather than a sequential loop: the queries are independent,
	// each with its own window and axis. Sequentially they add up — the 27.8 ms
	// per request in verifyEquivalence is exactly the sum of waits, not the cost
	// of SQL.
	async pointVector(
		pluginId: string,
		entityKeys: Record<string, string>,
		at: Date,
	): Promise<FeatureValues> {
		const plugin = this.registry.get(pluginId)

		const values = await Promise.all(
			plugin.features.map((spec) => {
				const entityValue = entityKeys[spec.entity]
				// No axis means a null value, but the key stays in the vector. The
				// set of columns has to match the plugin declaration: the model
				// tells features apart by position, and the snapshot is compared
				// with what the windowed form writes.
				return entityValue === undefined
					? null
					: this.pointFeature(pluginId, spec.name, entityValue, at)
			}),
		)

		return Object.fromEntries(
			plugin.features.map((spec, index) => [spec.name, values[index]]),
		)
	}

	// The project's central check. A feature is declared once but executed by
	// two different SQL forms: windowed (training, backtest) and pointwise
	// (real-time scoring). The measurement that forced two: 590k events for one
	// feature — 28 minutes with pointwise queries against 1.5 s in a single
	// pass.
	//
	// The promise of "one code path" cannot be kept with two forms, so the
	// guarantee is moved: one definition, one compiler, and the equivalence of
	// the forms is CHECKED. It is checked here — otherwise train/serve skew
	// settles in silently: the model trains on the windowed form's numbers while
	// production gets the pointwise form's, and the backtest will not show it,
	// because it runs on the windowed form too.
	//
	// What is compared is values, not expressions: an already materialized
	// vector is taken and recomputed by the pointwise form as of the same
	// event.
	async verifyEquivalence(
		pluginId: string,
		sample: number,
	): Promise<EquivalenceReport> {
		const plugin = this.registry.get(pluginId)
		const startedAt = Date.now()

		// TABLESAMPLE rather than ORDER BY random(): on 26M rows the latter is a
		// full scan with a sort for the sake of a hundred rows.
		const events = await this.prisma.$queryRawUnsafe<SampledEvent[]>(
			`SELECT e.id, e."ingestedAt", e."entityKeys", v.values
       FROM "FeatureVector" v TABLESAMPLE SYSTEM (0.01)
       JOIN "Event" e ON e.id = v."eventId"
       WHERE e."pluginId" = $1
       LIMIT $2`,
			pluginId,
			sample,
		)

		const mismatches: Mismatch[] = []
		let checked = 0

		for (const event of events) {
			for (const spec of plugin.features) {
				const entityValue = event.entityKeys[spec.entity]

				const bulk = toNumber(event.values[spec.name])
				// The axis is absent from the event — the feature is undefined, and
				// both forms have to return null. These pairs are exactly where a
				// mismatch hides: PARTITION BY treats NULLs as equal, so a windowed
				// form that misses this case aggregates over every event without
				// that axis. Skipping the check where it is needed most means
				// checking what already works.
				const point =
					entityValue === undefined
						? null
						: await this.pointFeature(
								pluginId,
								spec.name,
								entityValue,
								event.ingestedAt,
							)
				checked++

				if (!same(bulk, point)) {
					mismatches.push({
						feature: spec.name,
						eventId: event.id,
						at: event.ingestedAt.toISOString(),
						bulk,
						point,
					})
				}
			}
		}

		const report: EquivalenceReport = {
			events: events.length,
			checked,
			mismatches: mismatches.length,
			byFeature: Object.fromEntries(
				plugin.features.map((f) => [
					f.name,
					mismatches.filter((m) => m.feature === f.name).length,
				]),
			),
			examples: mismatches.slice(0, 5),
			elapsedMs: Date.now() - startedAt,
		}

		const level = report.mismatches > 0 ? 'error' : 'log'
		this.logger[level]({
			actionCode: `windows.service.verifyEquivalence.${report.mismatches > 0 ? 'diverged' : 'ok'}`,
			pluginId,
			...report,
		})

		return report
	}

	private async run(
		what: string,
		pluginId: string,
		sql: string,
	): Promise<MaterializeReport> {
		const startedAt = Date.now()
		const rows = await this.prisma.$executeRawUnsafe(sql)
		const elapsedMs = Date.now() - startedAt

		this.logger.log({
			actionCode: `windows.service.materialize.${what}`,
			pluginId,
			rows,
			elapsedMs,
		})

		return { rows, elapsedMs }
	}
}
