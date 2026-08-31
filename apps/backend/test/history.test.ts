import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { AmountSpec } from '@mamir/contracts'
import type { Client } from 'pg'
import { portfolioSql } from '../src/windows/window-sql'
import {
	MOMENT,
	PLUGIN_ID,
	connect,
	createTestDatabase,
	label,
	seed,
} from './harness'

let db: Client

const stock = AmountSpec.parse({
	path: 'amount',
	position: 'entity',
	entity: 'acct',
	severity: 1,
})

interface Row {
	id: string
	entity: string
	outcome: boolean | null
	matured: boolean | null
}

async function portfolio(at: string, lookback = '7d'): Promise<Row[]> {
	const { rows } = await db.query(portfolioSql(PLUGIN_ID, stock, lookback), [
		at,
	])
	return rows
}

before(async () => {
	await createTestDatabase()
	db = await connect()
	await seed(db)
})

after(async () => {
	await db?.end()
})

describe('historical run', () => {
	// Data ends on January 4: that is the latest anything is known about.
	// A label maturing later does not know the outcome — its `false` means
	// "has not happened yet".
	test('outcome is known only from matured labels', async () => {
		const before = await portfolio(MOMENT.day5)
		const [a, b] = before.sort((x, y) => x.entity.localeCompare(y.entity))

		await label(db, a.id, true, '2026-01-04T00:00:00')
		await label(db, b.id, false, '2026-01-09T00:00:00')

		const rows = await portfolio(MOMENT.day5)
		const byEntity = new Map(rows.map((r) => [r.entity, r]))

		assert.deepEqual(
			{
				outcome: byEntity.get('A')!.outcome,
				matured: byEntity.get('A')!.matured,
			},
			{ outcome: true, matured: true },
		)
		// Label exists but has not matured: no comparison is valid either way.
		assert.deepEqual(
			{
				outcome: byEntity.get('B')!.outcome,
				matured: byEntity.get('B')!.matured,
			},
			{ outcome: false, matured: false },
		)
	})

	// A position without a label and one with an unmatured label are different
	// cases and must not be merged: the first was never labeled for the
	// portfolio at all, the second is waiting out its horizon.
	test('position without a label differs from an unmatured one', async () => {
		await seed(db, [
			{ acct: 'D', at: '2026-01-02T00:00:00', amount: 7, kind: 'x' },
		])

		const rows = await portfolio(MOMENT.day5)
		const d = rows.find((r) => r.entity === 'D')!

		assert.equal(d.outcome, null)
		assert.equal(d.matured, null)
	})

	// Flow position: for the second domain the position is the event itself,
	// and the outcome joins on it too.
	test('flow is compared by the outcome of its own event', async () => {
		const flow = AmountSpec.parse({
			path: 'amount',
			position: 'event',
			severity: 1,
		})
		const { rows } = await db.query<Row & { exposure: string }>(
			portfolioSql(PLUGIN_ID, flow, '7d'),
			[MOMENT.day5],
		)

		// Every fixture event is a position; flow needs no axis, so axis-less
		// events are in the portfolio too. 9 from the fixture + D from the
		// previous test.
		assert.equal(rows.length, 10)

		const byExposure = (amount: number) =>
			rows.find((r) => Number(r.exposure) === amount)!

		// Labels set by the first test on the last events of A and B find
		// their positions here too — by event id, not by entity.
		assert.deepEqual(
			{
				outcome: byExposure(500).outcome,
				matured: byExposure(500).matured,
			},
			{ outcome: true, matured: true },
		)
		assert.deepEqual(
			{
				outcome: byExposure(2000).outcome,
				matured: byExposure(2000).matured,
			},
			{ outcome: false, matured: false },
		)
		// Event without a label is not compared in either direction.
		assert.equal(byExposure(100).outcome, null)
	})
})
