import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// Prisma 7: the "prisma" block in package.json is no longer read, the config
// lives here. No adapter is needed for migrations — the CLI makes do with
// datasource.url.
export default defineConfig({
	schema: 'prisma/schema.prisma',
	migrations: {
		path: 'prisma/migrations',
	},
	datasource: {
		url: env('DATABASE_URL'),
	},
})
