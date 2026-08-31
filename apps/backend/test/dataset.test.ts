import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { ConfigService } from '@nestjs/config'
import type { Client } from 'pg'
import type { Env } from '../src/config/env'
import { DatasetService } from '../src/dataset/dataset.service'
import type { PluginRegistryService } from '../src/plugins/plugin-registry.service'
import {
	PLUGIN_ID,
	SPECS,
	TEST_DATABASE_URL,
	connect,
	createTestDatabase,
	seed,
} from './harness'

let db: Client
let work: string
let dataset: DatasetService

// The service is instantiated directly, without the Nest container: its only
// two dependencies are "give me the plugin" and "give me the connection
// string".
const registry = {
	get: () => ({ id: PLUGIN_ID, features: SPECS }),
} as unknown as PluginRegistryService

const config = {
	get: () => TEST_DATABASE_URL,
} as unknown as ConfigService<Env, true>

before(async () => {
	await createTestDatabase()
	db = await connect()
	await seed(db)

	// The export joins vector and label, so the fixture needs both tables.
	// All events are inserted at the very same moment — this is exactly where
	// sorting by occurredAt stops being a total order.
	await db.query(`
		INSERT INTO "FeatureVector" (id, "eventId", values)
		SELECT gen_random_uuid(), e.id,
		       jsonb_build_object(${SPECS.map((s, i) => `'${s.name}', ${i + 1}`).join(', ')})
		FROM "Event" e
	`)
	await db.query(`
		INSERT INTO "Label" ("eventId", value, "resolvedAt")
		SELECT e.id, (e.payload->>'amount')::float8 > 500, e."ingestedAt"
		FROM "Event" e
	`)

	work = await mkdtemp(join(tmpdir(), 'mamir-dataset-'))
	dataset = new DatasetService(registry, config)
})

after(async () => {
	await db?.end()
	await rm(work, { recursive: true, force: true })
})

describe('training dataset export', () => {
	// Regression for a bug that made the published metrics table
	// non-reproducible: ORDER BY occurredAt is not a total order, while the
	// calibration share is cut by position in the file.
	test('two consecutive calls produce a byte-identical file', async () => {
		const options = {
			pluginId: PLUGIN_ID,
			until: new Date('2026-02-01T00:00:00Z'),
			maturedBy: 'history-end' as const,
		}

		const a = await dataset.export({ ...options, out: join(work, 'a.csv') })
		const b = await dataset.export({ ...options, out: join(work, 'b.csv') })

		assert.ok(a.rows > 0, 'export is empty — nothing to compare')
		assert.equal(a.rows, b.rows)
		assert.equal(
			readFileSync(join(work, 'a.csv'), 'utf8'),
			readFileSync(join(work, 'b.csv'), 'utf8'),
		)
	})

	test('event without a matured label is excluded from the dataset', async () => {
		const { rows: total } = await db.query('SELECT count(*)::int FROM "Event"')

		await db.query(
			`UPDATE "Label" SET "resolvedAt" = TIMESTAMP '2030-01-01'
			 WHERE "eventId" = (SELECT id FROM "Event" ORDER BY "ingestedAt" LIMIT 1)`,
		)

		const report = await dataset.export({
			pluginId: PLUGIN_ID,
			until: new Date('2026-02-01T00:00:00Z'),
			maturedBy: new Date('2026-02-01T00:00:00Z'),
			out: join(work, 'matured.csv'),
		})

		assert.equal(report.rows, total[0].count - 1)
	})
})
