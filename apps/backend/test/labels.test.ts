import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { LabelSpec } from '@mamir/contracts'
import type { Client } from 'pg'
import { bulkLabelSql } from '../src/windows/window-sql'
import { PLUGIN_ID, connect, createTestDatabase, seed } from './harness'

// The label is the foundation of the backtest: both training and the
// historical run's "realized" read it.

let db: Client

interface Row {
	acct: string | null
	at: string
	amount: number
	value: boolean
	resolved_at: string
}

async function labels(spec: unknown): Promise<Row[]> {
	const { rows } = await db.query(
		`SELECT l.value,
		        to_char(l.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS resolved_at,
		        e."entityKeys"->>'acct' AS acct,
		        to_char(e."occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
		        (e.payload->>'amount')::numeric AS amount
		 FROM (${bulkLabelSql(PLUGIN_ID, LabelSpec.parse(spec))}) l
		 JOIN "Event" e ON e.id = l.id`,
	)
	return rows.map((r) => ({ ...r, amount: Number(r.amount) }))
}

before(async () => {
	await createTestDatabase()
	db = await connect()
	await seed(db)
})

after(async () => {
	await db?.end()
})

describe('labels', () => {
	// self: the outcome is recorded in the event itself; the horizon is only
	// the confirmation delay.
	test('self labels by the event itself and matures by the horizon', async () => {
		const rows = await labels({
			scope: 'self',
			horizon: '7d',
			anyOf: [[{ field: 'kind', op: 'eq', value: 'x' }]],
		})

		// kind = x: A has three events out of five, B one, axis-less zero.
		assert.equal(rows.length, 9)
		assert.equal(rows.filter((r) => r.value).length, 4)

		const first = rows.find((r) => r.acct === 'A' && r.amount === 100)!
		assert.equal(first.value, true)
		assert.equal(first.resolved_at, '2026-01-08T00:00:00')
	})

	// DNF: OR between groups. A single equality is not enough for a real
	// domain.
	test('anyOf is a disjunction of condition groups', async () => {
		const rows = await labels({
			scope: 'self',
			horizon: '7d',
			anyOf: [
				[{ field: 'kind', op: 'eq', value: 'x' }],
				[{ field: 'amount', op: 'gte', value: 1000 }],
			],
		})

		// kind = x (4) ∪ amount ≥ 1000 (B:1000x already in the first group,
		// B:2000y, axis-less 9999 and 8888) — seven events out of nine.
		assert.equal(rows.filter((r) => r.value).length, 7)
	})

	// forward: the outcome occurs in FUTURE events of the same entity. Answers
	// computed by hand from the fixture: condition amount = 400, horizon 1 day.
	test('forward looks ahead by entity within the horizon', async () => {
		const rows = await labels({
			scope: 'forward',
			entity: 'acct',
			horizon: '1d',
			anyOf: [[{ field: 'amount', op: 'eq', value: 400 }]],
		})
		const at = (acct: string, amount: number) =>
			rows.find((r) => r.acct === acct && r.amount === amount)!

		// day2: the 400 event falls in (day2, day3] → loss.
		assert.equal(at('A', 200).value, true)
		// day1: (day1, day2] holds only 200 → no.
		assert.equal(at('A', 100).value, false)
		// day4: no future; 400 was in the past, and the label never looks back.
		assert.equal(at('A', 500).value, false)
		// B has no events with amount = 400 at all.
		assert.equal(at('B', 1000).value, false)
		assert.equal(at('B', 2000).value, false)

		// Maturation: the horizon counts from the event's moment.
		assert.equal(at('A', 200).resolved_at, '2026-01-03T00:00:00')
	})

	// The window boundary is strictly after the event's moment: a same-moment
	// peer is not visible — the same trap as with features, only with time's
	// sign flipped.
	test('simultaneous event does not become its own outcome', async () => {
		const rows = await labels({
			scope: 'forward',
			entity: 'acct',
			horizon: '1d',
			anyOf: [[{ field: 'amount', op: 'eq', value: 400 }]],
		})

		// A day3: the same-moment neighbor (400) matches the condition but is
		// not inside the (day3, day4] window; day4 carries 500 → label false.
		const row = rows.find((r) => r.acct === 'A' && r.amount === 300)!
		assert.equal(row.value, false)
	})

	// PARTITION BY treats NULLs as equal: axis-less events land in one
	// partition and see each other's "future". For features this hole is
	// closed; the label of an axis-less event is undefined altogether — the
	// entity to look forward by does not exist, and writing false would claim
	// "no loss occurred" without grounds.
	test('axis-less event gets no forward label', async () => {
		const rows = await labels({
			scope: 'forward',
			entity: 'acct',
			horizon: '1d',
			// 8888 sits at day3 on an axis-less event: with a shared NULL
			// partition the axis-less day2 (9999) would see it as its own "loss".
			anyOf: [[{ field: 'amount', op: 'eq', value: 8888 }]],
		})

		assert.equal(rows.filter((r) => r.acct === null).length, 0)
		// Events with an axis are still labeled as usual.
		assert.equal(rows.length, 7)
		assert.ok(rows.every((r) => !r.value))
	})
})
