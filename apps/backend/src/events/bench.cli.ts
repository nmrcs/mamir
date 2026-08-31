import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { PrismaService } from '../prisma/prisma.service'

// Benchmark of real-time ingestion: N sequential POST /events against a
// running core, p50/p95 client latency + the cold start of the first try.
// The per-stage breakdown (features / scoring HTTP) is printed by the core
// itself in the `events.service.ingest.accepted` log — featureMs and
// scoreMs fields.
//
// The payload is taken from the domain's first loaded event: constructing
// an event by hand would mean knowing the domain schema, and this file
// lives in the core.
//
// Ingestion is a write path: every POST records an Event + FeatureVector.
// In a research database the benchmark may not leave a trace — data arrives
// only via the loader — so everything created is deleted at the end, and
// the domain's max ingestedAt returns to its pre-benchmark state.
async function main(): Promise<void> {
	const flags = new Map<string, string>()
	const argv = process.argv.slice(2)
	for (let i = 0; i < argv.length; i += 2) {
		flags.set(argv[i].replace(/^--/, ''), argv[i + 1])
	}

	const pluginId = flags.get('plugin')
	const count = Number(flags.get('count') ?? 50)
	const base = flags.get('base') ?? 'http://localhost:3001'
	if (!pluginId) {
		throw new Error(
			'usage: bench --plugin <id> [--count 50] [--base http://localhost:3001]',
		)
	}

	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: ['log', 'warn', 'error'],
	})
	const logger = new Logger('Bench')
	const prisma = app.get(PrismaService)
	const created: string[] = []

	try {
		const sample = await prisma.event.findFirst({
			where: { pluginId, ingestRunId: { not: null } },
			orderBy: { id: 'asc' },
			select: { payload: true },
		})
		if (!sample) {
			throw new Error(`domain ${pluginId} has no loaded events`)
		}

		const post = async (): Promise<number> => {
			const startedAt = performance.now()
			const response = await fetch(`${base}/events`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pluginId, payload: sample.payload }),
			})
			const elapsed = performance.now() - startedAt
			if (!response.ok) {
				throw new Error(
					`the core answered ${response.status} — is it running at ${base}?`,
				)
			}
			const body = (await response.json()) as {
				eventId: string
				score: unknown
			}
			created.push(body.eventId)
			if (body.score === null) {
				throw new Error(
					'score: null — a benchmark without scoring would measure a different pipeline; start the sidecar and train a model',
				)
			}
			return elapsed
		}

		const cold = await post()
		const times: number[] = []
		for (let i = 0; i < count; i++) {
			times.push(await post())
		}

		times.sort((a, b) => a - b)
		const quantile = (q: number): number =>
			times[Math.min(times.length - 1, Math.floor(q * times.length))]

		logger.log({
			actionCode: 'events.bench.main.completed',
			pluginId,
			count,
			coldMs: Math.round(cold),
			p50Ms: Math.round(quantile(0.5)),
			p95Ms: Math.round(quantile(0.95)),
		})
	} finally {
		if (created.length) {
			await prisma.featureVector.deleteMany({
				where: { eventId: { in: created } },
			})
			await prisma.event.deleteMany({ where: { id: { in: created } } })
			logger.log({
				actionCode: 'events.bench.main.cleaned',
				deleted: created.length,
			})
		}
		await app.close()
	}
}

main().catch((error: Error) => {
	new Logger('Bench').error(error.message)
	process.exitCode = 1
})
