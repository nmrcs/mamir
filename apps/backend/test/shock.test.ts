import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { AmountSpec, ScenarioSpec } from '@mamir/contracts'
import type { Client } from 'pg'
import {
	bulkFeatureSql,
	positionSql,
	shockCoverageSql,
	shockReader,
} from '../src/windows/window-sql'
import {
	MOMENT,
	PLUGIN_ID,
	SPECS,
	connect,
	createTestDatabase,
	seed,
} from './harness'

let db: Client

const scenario = (patch: Record<string, unknown>) =>
	ScenarioSpec.parse({
		id: 'test',
		title: 'test',
		shock: [{ field: 'amount', op: 'mul', value: 2 }],
		...patch,
	})

const flow = AmountSpec.parse({
	path: 'amount',
	position: 'event',
	severity: 1,
})

before(async () => {
	await createTestDatabase()
	db = await connect()
	await seed(db)
})

after(async () => {
	await db?.end()
})

describe('scenario shock', () => {
	// A shock edits field values, and the feature compiler knows nothing about
	// it: it is written over the payload column and works on top of any source
	// of the same shape. No second code path appears for a feature.
	test('a shock reaches features through the same compiler', async () => {
		const spec = SPECS.filter((s) => s.name === 'acct_amount_sum_7d')

		const { rows: base } = await db.query(
			`SELECT * FROM (${bulkFeatureSql(PLUGIN_ID, spec)}) f`,
		)
		const { rows: shocked } = await db.query(
			`SELECT * FROM (${bulkFeatureSql(PLUGIN_ID, spec, {
				read: shockReader(scenario({})),
			})}) f`,
		)

		const sum = (rows: Record<string, unknown>[]) =>
			rows.reduce((acc, r) => acc + Number(r.acct_amount_sum_7d ?? 0), 0)

		assert.equal(sum(shocked), sum(base) * 2)
	})

	// Selection narrows the shock: untouched events have to stay as they were.
	test('select limits which events are shocked', async () => {
		const spec = SPECS.filter((s) => s.name === 'acct_amount_sum_7d')
		const only = scenario({
			select: [{ field: 'kind', op: 'eq', value: 'zzz' }],
		})

		const { rows: base } = await db.query(
			`SELECT * FROM (${bulkFeatureSql(PLUGIN_ID, spec)}) f`,
		)
		const { rows: shocked } = await db.query(
			`SELECT * FROM (${bulkFeatureSql(PLUGIN_ID, spec, {
				read: shockReader(only),
			})}) f`,
		)

		const sum = (rows: Record<string, unknown>[]) =>
			rows.reduce((acc, r) => acc + Number(r.acct_amount_sum_7d ?? 0), 0)

		assert.equal(sum(shocked), sum(base))
	})

	// The difference between "the portfolio is resilient" and "the shock reached
	// no row at all". By ΔEL they are indistinguishable, so coverage has to tell
	// them apart.
	test('coverage separates what was selected from what actually changed', async () => {
		const missing = scenario({
			shock: [{ field: 'nonexistent_field', op: 'mul', value: 2 }],
		})

		const [row] = (
			await db.query(shockCoverageSql(PLUGIN_ID, missing, '7d'), [MOMENT.day5])
		).rows

		assert.ok(row.scanned > 0)
		assert.equal(row.selected, row.scanned)
		assert.equal(row.shocked0, 0)
	})

	// The transform's second operation: a shift rather than a multiplier. In
	// credit-risk it declares a rise in the rate in percentage points.
	test('add shifts every value by a constant', async () => {
		const base = await db.query(
			`SELECT count(*) AS n, sum(exposure) AS total
			 FROM (${positionSql(PLUGIN_ID, flow, '7d')}) p`,
			[MOMENT.day5],
		)
		const shocked = await db.query(
			`SELECT sum(exposure) AS total FROM (${positionSql(
				PLUGIN_ID,
				flow,
				'7d',
				shockReader(
					scenario({ shock: [{ field: 'amount', op: 'add', value: 50 }] }),
				),
			)}) p`,
			[MOMENT.day5],
		)

		assert.equal(
			Number(shocked.rows[0].total),
			Number(base.rows[0].total) + 50 * Number(base.rows[0].n),
		)
	})

	// The exposure field may be the shocked one: on a flow domain what is at
	// risk is the amount of the transaction itself. Then the shock has to move
	// the amount at risk too, otherwise ΔEL counts the shift in probability and
	// loses the shift in amount.
	test('shocking the exposure field moves the amount at risk', async () => {
		const base = await db.query(
			`SELECT sum(exposure) AS total FROM (${positionSql(PLUGIN_ID, flow, '7d')}) p`,
			[MOMENT.day5],
		)
		const shocked = await db.query(
			`SELECT sum(exposure) AS total FROM (${positionSql(
				PLUGIN_ID,
				flow,
				'7d',
				shockReader(scenario({})),
			)}) p`,
			[MOMENT.day5],
		)

		assert.equal(Number(shocked.rows[0].total), Number(base.rows[0].total) * 2)
	})
})
