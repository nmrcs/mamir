import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { IngestService, type IngestOptions } from './ingest.service'

// Bulk loading is a CLI, not HTTP: millions of events at one request per
// event make no sense. The same application context is booted, so the
// plugin registry, validator and extractors here are exactly the prod ones.
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: ['log', 'warn', 'error'],
	})

	try {
		const report = await app.get(IngestService).fromSource(args)
		new Logger('Ingest').log({ actionCode: 'ingest.cli.main.done', ...report })
	} finally {
		await app.close()
	}
}

function parseArgs(argv: string[]): IngestOptions {
	// A value is optional: `--force` stands alone, and by eating the next
	// argument the parser would silently drop the adjacent flag.
	const flags = new Map<string, string>()
	for (let i = 0; i < argv.length; i++) {
		const name = argv[i].replace(/^--/, '')
		const next = argv[i + 1]
		if (next !== undefined && !next.startsWith('--')) {
			flags.set(name, next)
			i++
		} else {
			flags.set(name, '')
		}
	}

	const pluginId = flags.get('plugin')
	const source = flags.get('source')
	const dataDir = flags.get('data')

	if (!pluginId || !source || !dataDir) {
		throw new Error(
			'usage: ingest --plugin <id> --source <descriptor.json> --data <dir> [--cohort 2007] [--limit N] [--force]',
		)
	}

	const limit = flags.get('limit')
	return {
		pluginId,
		source,
		dataDir,
		limit: limit ? Number(limit) : undefined,
		cohort: flags.get('cohort'),
		force: flags.has('force'),
	}
}

main().catch((error: Error) => {
	new Logger('Ingest').error({
		actionCode: 'ingest.cli.main.failed',
		message: error.message,
	})
	process.exit(1)
})
