import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expectedLoss, realizedLoss } from '../src/exposure/loss'

// Numbers the engine prints as money. Tests of the inputs — contract,
// window SQL, export — do not see the loss arithmetic itself: a factor
// missing from the formula keeps every one of them green.
describe('expected loss', () => {
	test('it is a product of three factors, not two', () => {
		// The missing factor itself: without it the answer would be 5000.
		assert.equal(expectedLoss(0.05, 0.47, 100_000), 0.05 * 0.47 * 100_000)
		assert.notEqual(expectedLoss(0.05, 0.47, 100_000), 0.05 * 100_000)
	})

	test('loss severity of one does not change the amount', () => {
		// An uncollateralized domain declares 1 — a declaration, not a default.
		assert.equal(expectedLoss(0.3, 1, 250), 75)
	})

	test('zero probability and zero exposure yield zero', () => {
		assert.equal(expectedLoss(0, 0.47, 100_000), 0)
		assert.equal(expectedLoss(0.9, 0.47, 0), 0)
	})

	test('the amount is linear in each factor', () => {
		// The property all portfolio arithmetic rests on: doubling any of the
		// three doubles the result. Breaks on any attempt to "fix" the formula
		// with nonlinearity.
		const base = expectedLoss(0.1, 0.5, 1000)
		assert.equal(expectedLoss(0.2, 0.5, 1000), base * 2)
		assert.equal(expectedLoss(0.1, 1, 1000), base * 2)
		assert.equal(expectedLoss(0.1, 0.5, 2000), base * 2)
	})
})

describe('realized loss', () => {
	test('an occurred event takes the severity share, not the full amount', () => {
		assert.equal(realizedLoss(true, 0.47, 100_000), 47_000)
	})

	test('a non-occurred event takes nothing', () => {
		assert.equal(realizedLoss(false, 0.47, 100_000), 0)
	})

	test('both sides of the comparison measure the same thing', () => {
		// The "predicted vs realized" gap is a ratio, and it is meaningful only
		// if loss severity enters both sides. A position with probability 1
		// whose event occurred must yield identical predicted and realized
		// values.
		const severity = 0.47
		const exposure = 100_000
		assert.equal(
			expectedLoss(1, severity, exposure),
			realizedLoss(true, severity, exposure),
		)
	})
})

describe('portfolio on toy numbers', () => {
	// Three positions, answers computed by hand.
	const severity = 0.5
	const positions = [
		{ probability: 0.1, exposure: 1000 }, // 50
		{ probability: 0.2, exposure: 2000 }, // 200
		{ probability: 0.5, exposure: 100 }, // 25
	]
	const loss = (p: (typeof positions)[number]): number =>
		expectedLoss(p.probability, severity, p.exposure)

	test('portfolio expected loss is the sum over positions', () => {
		assert.equal(
			positions.reduce((sum, p) => sum + loss(p), 0),
			275,
		)
	})

	test('the tail sorts by loss contribution, not by position size', () => {
		// The third position is the most probable (0.5) but the smallest — no
		// threat to the portfolio. The first is ten times larger yet
		// contributes twice as much.
		const byLoss = [...positions].sort((a, b) => loss(b) - loss(a))
		assert.deepEqual(
			byLoss.map((p) => p.exposure),
			[2000, 1000, 100],
		)
	})

	test('slice share is computed against the portfolio total', () => {
		const byLoss = [...positions].sort((a, b) => loss(b) - loss(a))
		const total = positions.reduce((sum, p) => sum + loss(p), 0)
		const top = byLoss.slice(0, 1).reduce((sum, p) => sum + loss(p), 0)
		// 200 out of 275
		assert.equal(top / total, 200 / 275)
	})

	test('loss severity cancels in ratios but not in sums', () => {
		// The key property of the correction: concentration and gaps are
		// unchanged, absolute money changed by exactly the severity factor.
		const other = 1
		const lossOther = (p: (typeof positions)[number]): number =>
			expectedLoss(p.probability, other, p.exposure)

		const total = positions.reduce((sum, p) => sum + loss(p), 0)
		const totalOther = positions.reduce((sum, p) => sum + lossOther(p), 0)
		assert.equal(total, totalOther * severity)

		const share = loss(positions[1]) / total
		const shareOther = lossOther(positions[1]) / totalOther
		assert.equal(share, shareOther)
	})
})
