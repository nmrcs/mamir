import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'
import type { Env } from '../config/env'

// Prisma 7: the Rust query engine is gone, SQL is executed by pg through an
// adapter. The runtime connection string lives here — it cannot be set in the
// schema, `url` in datasource is no longer supported. The CLI takes its own
// prisma.config.ts.
@Injectable()
export class PrismaService
	extends PrismaClient
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(PrismaService.name)

	constructor(config: ConfigService<Env, true>) {
		super({
			adapter: new PrismaPg({
				connectionString: config.get('DATABASE_URL', { infer: true }),
			}),
		})
	}

	async onModuleInit(): Promise<void> {
		await this.$connect()
		this.logger.log({ actionCode: 'prisma.service.init.connected' })
	}

	async onModuleDestroy(): Promise<void> {
		await this.$disconnect()
	}
}
