import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import type { INestApplication } from '@nestjs/common'
import type { Client } from 'pg'
import { TEST_DATABASE_URL, connect, createTestDatabase } from './harness'

// Smoke run of POST /events against a live application. This is the only
// endpoint called neither by the frontend nor by scripts — only by an
// external client — nothing else exercises real-time ingestion end to end.
//
// The environment is set BEFORE importing AppModule: Prisma reads
// DATABASE_URL from process.env, the registry reads PLUGINS via ConfigModule.
// Scoring points at a port with no listener — the degradation here is real,
// not simulated.
process.env.DATABASE_URL = TEST_DATABASE_URL
process.env.PLUGINS = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'fixture-plugin.ts',
)
process.env.SCORING_URL = 'http://127.0.0.1:59999'

let app: INestApplication
let db: Client
let base: string

async function post(body: unknown): Promise<Response> {
	return fetch(`${base}/events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
}

before(async () => {
	await createTestDatabase()
	db = await connect()

	// The app boots from dist, not from src: Nest constructor DI relies on
	// emitDecoratorMetadata, which esbuild under tsx does not emit. As a bonus,
	// e2e verifies the same artifact that ships to production.
	const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	execFileSync('npx', ['nest', 'build'], { cwd: backend, stdio: 'pipe' })

	const { NestFactory } = await import('@nestjs/core')
	const { AppModule } = (await import('../dist/app.module')) as {
		AppModule: new () => unknown
	}
	app = (await NestFactory.create(AppModule, {
		logger: false,
	})) as INestApplication
	await app.listen(0, '127.0.0.1')
	base = await app.getUrl()
})

after(async () => {
	await app?.close()
	await db?.end()
})

describe('event ingestion', () => {
	test('event accepted: Event and FeatureVector are written', async () => {
		const res = await post({
			pluginId: 'test_domain',
			payload: { t: 86_400, amount: 250, kind: 'ok', acct: 'A' },
		})
		assert.equal(res.status, 201)

		const body = (await res.json()) as {
			eventId: string
			occurredAt: string
			entityKeys: Record<string, string>
			score: unknown
		}
		// Seconds conversion took the live path: t = 86,400 is day two of the epoch.
		assert.equal(body.occurredAt, '1970-01-02T00:00:00.000Z')
		assert.deepEqual(body.entityKeys, { acct: 'A' })

		const event = await db.query('SELECT id FROM "Event" WHERE id = $1::uuid', [
			body.eventId,
		])
		const vector = await db.query(
			'SELECT values FROM "FeatureVector" WHERE "eventId" = $1',
			[body.eventId],
		)
		assert.equal(event.rows.length, 1)
		assert.equal(vector.rows.length, 1)
	})

	// An ML failure does not cancel ingestion: the event is a domain fact with
	// nothing to recover it from, while the score can be recomputed from the
	// stored vector.
	test('scoring is down — event accepted with score: null', async () => {
		const res = await post({
			pluginId: 'test_domain',
			payload: { t: 172_800, amount: 90, kind: 'ok' },
		})
		assert.equal(res.status, 201)

		const body = (await res.json()) as { score: unknown }
		assert.equal(body.score, null)
	})

	test('payload violating the plugin schema — 400 with a list of issues', async () => {
		const res = await post({
			pluginId: 'test_domain',
			payload: { t: 86_400, amount: 'not-a-number', kind: 'ok' },
		})
		assert.equal(res.status, 400)

		const body = (await res.json()) as { issues: { path: unknown[] }[] }
		assert.ok(body.issues.some((issue) => issue.path.includes('amount')))
	})

	test('unregistered plugin — 400, not 500', async () => {
		const res = await post({ pluginId: 'no_such_domain', payload: {} })
		assert.equal(res.status, 400)
	})
})
