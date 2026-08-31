import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { WindowsService } from './windows.service'

// Materializing features and labels. A pass over the whole history is not an
// HTTP operation.
async function main(): Promise<void> {
	const flags = new Map<string, string>()
	const argv = process.argv.slice(2)
	for (let i = 0; i < argv.length; i += 2) {
		flags.set(argv[i].replace(/^--/, ''), argv[i + 1])
	}

	const pluginId = flags.get('plugin')
	const what = flags.get('what') ?? 'all'
	const sample = Number(flags.get('sample') ?? 100)
	if (!pluginId) {
		throw new Error(
			'usage: windows --plugin <id> [--what indexes|labels|features|verify|all] [--sample N]',
		)
	}

	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: ['log', 'warn', 'error'],
	})
	const logger = new Logger('Windows')

	try {
		const windows = app.get(WindowsService)

		if (what === 'indexes' || what === 'all') {
			const indexes = await windows.ensureIndexes(pluginId)
			logger.log({ actionCode: 'windows.cli.main.indexes', indexes })
		}
		if (what === 'labels' || what === 'all') {
			const report = await windows.materializeLabels(pluginId)
			logger.log({ actionCode: 'windows.cli.main.labels', ...report })
		}
		if (what === 'features' || what === 'all') {
			const report = await windows.materializeFeatures(pluginId)
			logger.log({ actionCode: 'windows.cli.main.features', ...report })
		}
		// Not part of 'all': the check runs against already materialized vectors,
		// and running it in the same pass that computes them means checking a
		// fresh result against itself.
		if (what === 'verify') {
			const report = await windows.verifyEquivalence(pluginId, sample)
			logger.log({ actionCode: 'windows.cli.main.verify', ...report })
			if (report.mismatches > 0) {
				process.exitCode = 1
			}
		}
	} finally {
		await app.close()
	}
}

main().catch((error: Error) => {
	new Logger('Windows').error({
		actionCode: 'windows.cli.main.failed',
		message: error.message,
	})
	process.exit(1)
})
