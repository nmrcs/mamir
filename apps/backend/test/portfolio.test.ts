import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { AmountSpec } from '@mamir/contracts'
import type { Client } from 'pg'
import { positionSql } from '../src/windows/window-sql'
import { MOMENT, PLUGIN_ID, connect, createTestDatabase, seed } from './harness'

let db: Client

const stock = AmountSpec.parse({
	path: 'amount',
	position: 'entity',
	entity: 'acct',
	severity: 1,
})
const flow = AmountSpec.parse({
	path: 'amount',
	position: 'event',
	severity: 1,
})

async function portfolio(
	spec: typeof stock,
	at: string,
	lookback = '7d',
): Promise<{ entity: string; exposure: number }[]> {
	const { rows } = await db.query(
		positionSql(PLUGIN_ID, spec, lookback) + ' ',
		[at],
	)
	return rows.map((row) => ({
		entity: row.entity,
		exposure: Number(row.exposure),
	}))
}

before(async () => {
	await createTestDatabase()
	db = await connect()
	await seed(db)
})

after(async () => {
	await db?.end()
})

describe('portfolio', () => {
	// Stock: one entity has many events but a single position — the last one.
	// Summing all events would give a portfolio several times the real one.
	test('stock takes the last event of each entity', async () => {
		const rows = await portfolio(stock, MOMENT.day5)

		assert.equal(rows.length, 2)
		assert.deepEqual(
			rows.sort((a, b) => a.entity.localeCompare(b.entity)),
			[
				{ entity: 'A', exposure: 500 },
				{ entity: 'B', exposure: 2000 },
			],
		)
	})

	// Flow: the position is the event itself, nothing to collapse.
	test('flow takes every event', async () => {
		const rows = await portfolio(flow, MOMENT.day5)

		assert.equal(rows.length, 9)
		assert.equal(
			rows.reduce((sum, r) => sum + r.exposure, 0),
			23387,
		)
	})

	// The same strict boundary as the feature window: the portfolio at moment
	// t is built from what was known BEFORE t.
	test('portfolio at moment t excludes events of t itself', async () => {
		const rows = await portfolio(stock, MOMENT.day3)

		assert.deepEqual(
			rows.sort((a, b) => a.entity.localeCompare(b.entity)),
			[
				{ entity: 'A', exposure: 200 },
				{ entity: 'B', exposure: 1000 },
			],
		)
	})

	test('axis-less event does not enter the stock portfolio', async () => {
		const rows = await portfolio(stock, MOMENT.day5)
		assert.equal(
			rows.every((r) => r.entity === 'A' || r.entity === 'B'),
			true,
		)
	})

	// A position is "alive" while events kept arriving for it. Without the
	// boundary, entities that went silent twenty years ago would enter the
	// portfolio.
	test('lookback window cuts off long-silent entities', async () => {
		await seed(db, [
			{ acct: 'C', at: '2026-01-01T00:00:00', amount: 42, kind: 'x' },
		])

		const wide = await portfolio(stock, MOMENT.day5, '7d')
		const narrow = await portfolio(stock, MOMENT.day5, '2d')

		assert.equal(
			wide.some((r) => r.entity === 'C'),
			true,
		)
		assert.equal(
			narrow.some((r) => r.entity === 'C'),
			false,
		)
	})
})
