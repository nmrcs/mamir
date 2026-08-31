import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { validateEnv } from './config/env'
import { EventsModule } from './events/events.module'
import { HealthModule } from './health/health.module'
import { IngestModule } from './ingest/ingest.module'
import { PluginsModule } from './plugins/plugins.module'
import { PrismaModule } from './prisma/prisma.module'
import { BacktestModule } from './backtest/backtest.module'
import { ExposureModule } from './exposure/exposure.module'
import { HistoryModule } from './history/history.module'
import { ScenariosModule } from './scenarios/scenarios.module'
import { WindowsModule } from './windows/windows.module'

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
		PrismaModule,
		PluginsModule,
		EventsModule,
		IngestModule,
		WindowsModule,
		BacktestModule,
		ExposureModule,
		ScenariosModule,
		HistoryModule,
		HealthModule,
	],
})
export class AppModule {}
