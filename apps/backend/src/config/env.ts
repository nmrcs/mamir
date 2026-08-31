import { z } from 'zod'

const envSchema = z.object({
	DATABASE_URL: z.string().min(1),
	PORT: z.coerce.number().int().positive().default(3001),
	SCORING_URL: z.url(),
	// A comma-separated list of plugins. An empty list is valid: the core comes
	// up with no domains — it knows nothing about them anyway.
	PLUGINS: z
		.string()
		.default('')
		.transform((raw) =>
			raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		),
})

export type Env = z.infer<typeof envSchema>

export function validateEnv(config: Record<string, unknown>): Env {
	return envSchema.parse(config)
}
