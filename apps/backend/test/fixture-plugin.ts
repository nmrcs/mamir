// Fixture plugin for e2e ingestion: the registry loads it by absolute path
// from PLUGINS — the same mechanism as real domains. A minimal valid
// declaration; the rich feature set lives in harness.ts and is verified
// directly through the window compiler, while here the ingestion pipeline
// itself is verified.
export default {
	id: 'test_domain',
	version: '0.0.0',

	event: {
		t: { type: 'number' },
		amount: { type: 'number' },
		kind: { type: 'string' },
		acct: { type: 'string', required: false },
	},

	entityKeys: { acct: 'acct' },
	occurredAt: { path: 't', unit: 'seconds' },
	exposure: { path: 'amount', position: 'event', severity: 1 },
	correlation: 0,

	features: [
		{ name: 'acct_events_7d', entity: 'acct', agg: 'count', window: '7d' },
	],

	label: {
		scope: 'self',
		horizon: '7d',
		anyOf: [[{ field: 'kind', op: 'eq', value: 'bad' }]],
	},
}
