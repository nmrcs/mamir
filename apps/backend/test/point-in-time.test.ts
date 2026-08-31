import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Client } from 'pg'
import { bulkFeatureSql, pointFeatureSql } from '../src/windows/window-sql'
import {
	MOMENT,
	PLUGIN_ID,
	SPECS,
	connect,
	createTestDatabase,
	seed,
} from './harness'

let db: Client

const spec = (name: string) => SPECS.find((s) => s.name === name)!

async function point(
	name: string,
	acct: string,
	at: string,
): Promise<number | null> {
	const { rows } = await db.query(pointFeatureSql(PLUGIN_ID, spec(name)), [
		acct,
		at,
	])
	return rows[0].value === null ? null : Number(rows[0].value)
}

async function bulk(): Promise<Map<string, Record<string, unknown>>> {
	const { rows } = await db.query(
		`SELECT b.*,
		        to_char(e."ingestedAt", 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
		        e."entityKeys"->>'acct' AS acct
		 FROM (${bulkFeatureSql(PLUGIN_ID, SPECS)}) b
		 JOIN "Event" e ON e.id = b.id`,
	)
	return new Map(rows.map((row) => [row.id, row]))
}

before(async () => {
	await createTestDatabase()
	db = await connect()
	await seed(db)
})

after(async () => {
	await db?.end()
})

describe('point-in-time', () => {
	// The project's main test. A failure means future leakage into a feature.
	test('feature at moment t does not change from events arriving later', async () => {
		const before = await point('acct_events_7d', 'A', MOMENT.day3)
		const sumBefore = await point('acct_amount_sum_7d', 'A', MOMENT.day3)

		await seed(db, [
			{ acct: 'A', at: '2026-01-06T00:00:00Z', amount: 777, kind: 'w' },
			{ acct: 'A', at: '2026-01-07T00:00:00Z', amount: 888, kind: 'w' },
		])

		assert.equal(await point('acct_events_7d', 'A', MOMENT.day3), before)
		assert.equal(await point('acct_amount_sum_7d', 'A', MOMENT.day3), sumBefore)
	})

	// The window boundary is strictly `<`, not `<=`: order within one second
	// is arbitrary, and if events see each other the feature depends on
	// insertion order.
	test('simultaneous events do not see each other', async () => {
		// At day3, A has the day1 and day2 events — exactly two. Neither event
		// of day3 itself enters the window, including the same-moment neighbor.
		assert.equal(await point('acct_events_7d', 'A', MOMENT.day3), 2)
		assert.equal(await point('acct_amount_sum_7d', 'A', MOMENT.day3), 300)

		const rows = await bulk()
		const atDay3 = [...rows.values()].filter(
			(row) => row.acct === 'A' && row.at === MOMENT.day3,
		)

		assert.equal(atDay3.length, 2)
		for (const row of atDay3) {
			assert.equal(Number(row.acct_events_7d), 2)
		}
	})

	// Two forms of one definition. A divergence means training and real-time
	// compute different numbers.
	test('pointwise and windowed forms agree on all events', async () => {
		const rows = await bulk()
		let compared = 0

		for (const row of rows.values()) {
			const at = row.at as string

			for (const s of SPECS) {
				const windowed = row[s.name] === null ? null : Number(row[s.name])

				// An axis-less event has nothing to compare against — which is
				// no reason to skip it: these pairs are exactly where the forms
				// diverge (PARTITION BY treats NULLs as equal). Verify the
				// windowed form returns null, same as the pointwise one.
				if (row.acct === null) {
					assert.equal(
						windowed,
						null,
						`${s.name}: axis-less event must yield null, not ${String(windowed)}`,
					)
					continue
				}

				const pointwise = await point(s.name, row.acct as string, at)
				assert.equal(
					windowed,
					pointwise,
					`${s.name} at ${at}: windowed ${String(windowed)} vs pointwise ${String(pointwise)}`,
				)
				compared++
			}
		}

		assert.ok(compared > 0, 'no pairs were compared')
	})

	// A declared aggregate that nothing executes can hide invalid SQL —
	// distinct is executed here and its semantics pinned.
	test('distinct counts distinct values, not rows', async () => {
		// A before day5: kind x, y, x, z, x — three distinct.
		assert.equal(await point('acct_kinds_7d', 'A', MOMENT.day5), 3)
	})

	test('feature filter is applied, not ignored', async () => {
		// amount >= 300 before day5 for A: 300, 400, 500 — three events of five.
		assert.equal(await point('acct_big_events_7d', 'A', MOMENT.day5), 3)
		assert.equal(await point('acct_events_7d', 'A', MOMENT.day5), 5)
	})

	// Answers computed by hand: checking the implementation against itself is
	// pointless.
	test('std, min and the in filter yield hand-computed values', async () => {
		// A before day5: amounts 100..500. Sample σ of a set stepping by 100
		// around mean 300: √((200²+100²+0+100²+200²)/4) = √25000.
		const std = await point('acct_amount_std_7d', 'A', MOMENT.day5)
		assert.ok(Math.abs((std ?? 0) - Math.sqrt(25000)) < 1e-9)

		assert.equal(await point('acct_amount_min_7d', 'A', MOMENT.day5), 100)

		// kind ∈ {x, y} for A before day5: x, y, x, x — four events of five.
		assert.equal(await point('acct_xy_events_7d', 'A', MOMENT.day5), 4)
	})
})
