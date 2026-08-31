import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AmountSpec, TimeSpec } from '@mamir/contracts'
import { extractExposure, extractOccurredAt } from '../src/events/event-payload'

// Timestamp and amount conversion is a system boundary: every event of both
// domains passes through it. Answers are computed by hand; the run uses
// TZ=Asia/Tokyo, so matching the UTC string also proves independence from
// the machine's time zone.

describe('timestamp and amount extraction', () => {
	test('seconds — relative time from the zero point', () => {
		const spec = TimeSpec.parse({ path: 't', unit: 'seconds' })

		assert.equal(
			extractOccurredAt(spec, { t: 86_400 }).toISOString(),
			'1970-01-02T00:00:00.000Z',
		)
		assert.equal(
			extractOccurredAt(spec, { t: 86_401.5 }).toISOString(),
			'1970-01-02T00:00:01.500Z',
		)
	})

	test('yyyymm — first day of the reporting month, including the year boundary', () => {
		const spec = TimeSpec.parse({ path: 'period', unit: 'yyyymm' })

		assert.equal(
			extractOccurredAt(spec, { period: 200704 }).toISOString(),
			'2007-04-01T00:00:00.000Z',
		)
		assert.equal(
			extractOccurredAt(spec, { period: 199912 }).toISOString(),
			'1999-12-01T00:00:00.000Z',
		)
		assert.equal(
			extractOccurredAt(spec, { period: 200001 }).toISOString(),
			'2000-01-01T00:00:00.000Z',
		)
	})

	test('exposure — string with four decimal places, matching Decimal(18,4)', () => {
		const spec = AmountSpec.parse({
			path: 'amt',
			position: 'event',
			severity: 1,
		})

		assert.equal(extractExposure(spec, { amt: 123.456789 }), '123.4568')
		assert.equal(extractExposure(spec, { amt: 250_000 }), '250000.0000')
	})
})
