import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DomainPlugin } from '@mamir/contracts'

// The contract is the only boundary through which a domain enters the core.
// It is validated at startup, so a typo in the declaration must fail there,
// not two hours into a backtest.
const valid = {
	id: 'fixture',
	version: '0.1.0',
	event: {
		acct: { type: 'string' },
		amount: { type: 'number' },
		at: { type: 'number' },
		bad: { type: 'boolean' },
	},
	entityKeys: { acct: 'acct' },
	occurredAt: { path: 'at', unit: 'seconds' },
	exposure: {
		path: 'amount',
		position: 'entity',
		entity: 'acct',
		severity: 1,
	},
	correlation: 0,
	features: [
		{ name: 'acct_events_7d', entity: 'acct', agg: 'count', window: '7d' },
	],
	label: {
		scope: 'self',
		entity: 'acct',
		horizon: '7d',
		anyOf: [[{ field: 'bad', op: 'eq', value: true }]],
	},
}

const broken = (patch: Record<string, unknown>): unknown => ({
	...valid,
	...patch,
})

describe('plugin contract', () => {
	test('valid declaration is accepted', () => {
		assert.equal(DomainPlugin.safeParse(valid).success, true)
	})

	test('aggregation axis missing from the event schema is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({ entityKeys: { acct: 'nonexistent' } }),
		)
		assert.equal(result.success, false)
	})

	test('feature over an undeclared axis is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				features: [
					{ name: 'x', entity: 'unknown_axis', agg: 'count', window: '7d' },
				],
			}),
		)
		assert.equal(result.success, false)
	})

	test('aggregate that needs a field is rejected without source', () => {
		const result = DomainPlugin.safeParse(
			broken({
				features: [{ name: 'x', entity: 'acct', agg: 'sum', window: '7d' }],
			}),
		)
		assert.equal(result.success, false)
	})

	test('numeric aggregate over a non-numeric field is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				features: [
					{
						name: 'x',
						entity: 'acct',
						source: 'acct',
						agg: 'sum',
						window: '7d',
					},
				],
			}),
		)
		assert.equal(result.success, false)
	})

	test('scenario shocking a nonexistent field is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				scenarios: [
					{
						id: 'shock',
						title: 'shock',
						shock: [{ field: 'nonexistent', op: 'mul', value: 2 }],
					},
				],
			}),
		)
		assert.equal(result.success, false)
	})

	// Stock and flow are different portfolios, and mixing them up is the most
	// expensive mistake: for a balance-sheet domain summing over events would
	// inflate exposure tens of times, while for a flow domain "last value per
	// entity" makes no sense at all.
	test('flow is declared without an axis', () => {
		const result = DomainPlugin.safeParse(
			broken({ exposure: { path: 'amount', position: 'event', severity: 1 } }),
		)
		assert.equal(result.success, true)
	})

	test('stock without an axis is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({ exposure: { path: 'amount', position: 'entity', severity: 1 } }),
		)
		assert.equal(result.success, false)
	})

	test('flow with an axis is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				exposure: {
					path: 'amount',
					position: 'event',
					entity: 'acct',
					severity: 1,
				},
			}),
		)
		assert.equal(result.success, false)
	})

	test('exposure over an undeclared axis is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				exposure: {
					path: 'amount',
					position: 'entity',
					entity: 'unknown',
					severity: 1,
				},
			}),
		)
		assert.equal(result.success, false)
	})

	// Loss severity deliberately has no default: an omitted multiplier would
	// silently become one, and "event occurred — everything is lost" would turn
	// into an assumption nobody declared. Verified by violation, otherwise this
	// is a claim about the schema, not its property.
	test('exposure without loss severity is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				exposure: { path: 'amount', position: 'entity', entity: 'acct' },
			}),
		)
		assert.equal(result.success, false)
	})

	test('loss severity above one is rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				exposure: {
					path: 'amount',
					position: 'entity',
					entity: 'acct',
					severity: 1.5,
				},
			}),
		)
		assert.equal(result.success, false)
	})

	// Position correlation is the second assumption that would silently become
	// zero: an omitted field would mean "systemic risk does not exist", a claim
	// nobody made. Zero is declared, not implied.
	test('declaration without correlation is rejected', () => {
		const without: Record<string, unknown> = { ...valid }
		delete without.correlation
		assert.equal(DomainPlugin.safeParse(without).success, false)
	})

	test('correlation outside [0, 1) is rejected', () => {
		for (const correlation of [-0.1, 1, 1.5]) {
			assert.equal(
				DomainPlugin.safeParse(broken({ correlation })).success,
				false,
			)
		}
	})

	test('zero correlation is accepted', () => {
		assert.equal(
			DomainPlugin.safeParse(broken({ correlation: 0 })).success,
			true,
		)
	})

	test('duplicate feature names are rejected', () => {
		const result = DomainPlugin.safeParse(
			broken({
				features: [
					{ name: 'dup', entity: 'acct', agg: 'count', window: '7d' },
					{ name: 'dup', entity: 'acct', agg: 'count', window: '30d' },
				],
			}),
		)
		assert.equal(result.success, false)
	})
})
