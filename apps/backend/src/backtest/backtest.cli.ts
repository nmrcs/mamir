import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { BacktestService, type BacktestOptions } from './backtest.service'

// Running a backtest is a CLI job: training several models in a row is not a
// response to an HTTP request.
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: ['log', 'warn', 'error'],
	})

	try {
		const report = await app.get(BacktestService).run(args)
		new Logger('Backtest').log({
			actionCode: 'backtest.cli.main.done',
			steps: report.steps.length,
			elapsedMs: report.elapsedMs,
			runIds: report.runIds,
		})
	} finally {
		await app.close()
	}
}

function parseArgs(argv: string[]): BacktestOptions {
	const flags = new Map<string, string>()
	for (let i = 0; i < argv.length; i += 2) {
		flags.set(argv[i].replace(/^--/, ''), argv[i + 1])
	}

	const pluginId = flags.get('plugin')
	const testFrom = flags.get('from')

	if (!pluginId || !testFrom) {
		throw new Error(
			'usage: backtest --plugin <id> --from <YYYY-MM-DD> [--steps 6] [--step-months 12] [--calib 0.2] [--work data/backtest] — exports land in <work>/<plugin>',
		)
	}

	return {
		pluginId,
		testFrom: new Date(testFrom),
		steps: Number(flags.get('steps') ?? 6),
		stepMonths: Number(flags.get('step-months') ?? 12),
		calibrationFraction: Number(flags.get('calib') ?? 0.2),
		workDir: flags.get('work') ?? 'data/backtest',
	}
}

main().catch((error: Error) => {
	new Logger('Backtest').error({
		actionCode: 'backtest.cli.main.failed',
		message: error.message,
	})
	process.exit(1)
})
