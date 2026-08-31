import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FeatureSpec } from '@mamir/contracts'
import { Client } from 'pg'

// Tests run against a separate database: they recreate it, while the working
// one holds 27M events that take 287 seconds to restore.
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function databaseUrl(name: string): string {
	const url = new URL(process.env.DATABASE_URL as string)
	url.pathname = `/${name}`
	return url.toString()
}

export const TEST_DATABASE_URL = databaseUrl('mamir_test')

export const PLUGIN_ID = 'test_domain'

// The fixture domain is declared right here and registered nowhere: the core
// accepts a declaration, not a package, and the window compiler is easier to
// test on a minimal set than on a real plugin with nine features.
export const SPECS: FeatureSpec[] = [
	{ name: 'acct_events_7d', entity: 'acct', agg: 'count', window: '7d' },
	{
		name: 'acct_amount_sum_7d',
		entity: 'acct',
		source: 'amount',
		agg: 'sum',
		window: '7d',
	},
	{
		name: 'acct_amount_mean_7d',
		entity: 'acct',
		source: 'amount',
		agg: 'mean',
		window: '7d',
	},
	{
		name: 'acct_amount_std_7d',
		entity: 'acct',
		source: 'amount',
		agg: 'std',
		window: '7d',
	},
	{
		name: 'acct_amount_min_7d',
		entity: 'acct',
		source: 'amount',
		agg: 'min',
		window: '7d',
	},
	{
		name: 'acct_time_since_prev',
		entity: 'acct',
		agg: 'time_since',
		window: '7d',
	},
	// An aggregate declared in the contract but never executed can hide
	// invalid SQL. Here it always executes.
	{
		name: 'acct_kinds_7d',
		entity: 'acct',
		source: 'kind',
		agg: 'distinct',
		window: '7d',
	},
	// Feature with a filter: without where the counter would just count rows.
	{
		name: 'acct_big_events_7d',
		entity: 'acct',
		agg: 'count',
		window: '7d',
		where: [{ field: 'amount', op: 'gte', value: 300 }],
	},
	// Set-membership filter — the second operation declared by a real domain
	// (credit-risk selects disposition codes via in).
	{
		name: 'acct_xy_events_7d',
		entity: 'acct',
		agg: 'count',
		window: '7d',
		where: [{ field: 'kind', op: 'in', value: ['x', 'y'] }],
	},
].map((spec) => FeatureSpec.parse(spec))

// No zone suffix and no round-trip through Date: the column is declared
// `timestamp without time zone`, but the driver returns it as a local Date —
// the moment drifts by the machine's offset and comes back different.
const AT = (day: number, hour = 0): string =>
	`2026-01-0${day}T${String(hour).padStart(2, '0')}:00:00`

export interface FixtureEvent {
	acct: string | null
	at: string
	amount: number
	kind: string
}

// The fixture is built around three traps the project has already tripped on:
// simultaneous events (window boundary is strictly `<`), an event without an
// aggregation axis (`PARTITION BY` treats NULLs as equal), and the `distinct`
// aggregate.
export const FIXTURE: FixtureEvent[] = [
	{ acct: 'A', at: AT(1), amount: 100, kind: 'x' },
	{ acct: 'A', at: AT(2), amount: 200, kind: 'y' },
	// Two events at the very same moment: they must not see each other.
	{ acct: 'A', at: AT(3), amount: 300, kind: 'x' },
	{ acct: 'A', at: AT(3), amount: 400, kind: 'z' },
	{ acct: 'A', at: AT(4), amount: 500, kind: 'x' },
	{ acct: 'B', at: AT(2), amount: 1000, kind: 'x' },
	{ acct: 'B', at: AT(4), amount: 2000, kind: 'y' },
	// Event without an axis: its feature over that axis is undefined, not
	// equal to a count of all axis-less events.
	{ acct: null, at: AT(2), amount: 9999, kind: 'q' },
	{ acct: null, at: AT(3), amount: 8888, kind: 'q' },
]

export const MOMENT = {
	day2: AT(2),
	day3: AT(3),
	day5: AT(5),
}

export async function createTestDatabase(): Promise<void> {
	const admin = new Client({ connectionString: databaseUrl('postgres') })
	await admin.connect()
	try {
		await admin.query('DROP DATABASE IF EXISTS mamir_test WITH (FORCE)')
		await admin.query('CREATE DATABASE mamir_test')
	} finally {
		await admin.end()
	}

	// The schema is applied via migrations, not assembled by hand in the test:
	// a test on a schema that differs from production verifies the wrong
	// system.
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		cwd: BACKEND,
		env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
		stdio: 'pipe',
	})
}

export async function connect(): Promise<Client> {
	const client = new Client({ connectionString: TEST_DATABASE_URL })
	await client.connect()
	return client
}

// Label for a single event: how it ended and when that became known.
// Separate from seed because not every test needs it — only the historical
// run reads the outcome.
export async function label(
	client: Client,
	eventId: string,
	value: boolean,
	resolvedAt: string,
): Promise<void> {
	await client.query(
		`INSERT INTO "Label" ("eventId", value, "resolvedAt")
		 VALUES ($1::uuid, $2, $3::timestamp)`,
		[eventId, value, resolvedAt],
	)
}

export async function seed(
	client: Client,
	events: FixtureEvent[] = FIXTURE,
): Promise<void> {
	for (const event of events) {
		await client.query(
			`INSERT INTO "Event" ("pluginId", "entityKeys", "occurredAt", "ingestedAt", exposure, payload)
			 VALUES ($1, $2::jsonb, $3::timestamp, $3::timestamp, $4, $5::jsonb)`,
			[
				PLUGIN_ID,
				JSON.stringify(event.acct === null ? {} : { acct: event.acct }),
				event.at,
				event.amount,
				JSON.stringify({ amount: event.amount, kind: event.kind }),
			],
		)
	}
}
