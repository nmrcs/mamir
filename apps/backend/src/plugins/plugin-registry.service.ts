import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DomainPlugin } from '@mamir/contracts'
import { z } from 'zod'
import type { Env } from '../config/env'

// The domain registry. The core does not import plugins statically and does not
// declare them as dependencies — they are resolved by name from env at runtime.
// That keeps the dependency graph pointing downwards: core → contracts,
// plugin → contracts, and never core → plugin.
@Injectable()
export class PluginRegistryService implements OnModuleInit {
	private readonly logger = new Logger(PluginRegistryService.name)
	private readonly plugins = new Map<string, DomainPlugin>()
	private readonly specifiers: string[]

	constructor(config: ConfigService<Env, true>) {
		this.specifiers = config.get('PLUGINS', { infer: true })
	}

	async onModuleInit(): Promise<void> {
		for (const specifier of this.specifiers) {
			const plugin = await this.load(specifier)

			const existing = this.plugins.get(plugin.id)
			if (existing) {
				throw new Error(
					`Plugin "${plugin.id}" is declared twice: ${specifier} conflicts with an already loaded one`,
				)
			}

			this.plugins.set(plugin.id, plugin)
			this.logger.log({
				actionCode: 'plugins.registry.load.loaded',
				specifier,
				pluginId: plugin.id,
				version: plugin.version,
				features: plugin.features.length,
				scenarios: plugin.scenarios.length,
			})
		}

		this.logger.log({
			actionCode: 'plugins.registry.init.ready',
			count: this.plugins.size,
			pluginIds: [...this.plugins.keys()],
		})
	}

	// The contract is validated as a whole at startup: a broken plugin brings the
	// process down instead of surfacing two hours into a backtest.
	private async load(specifier: string): Promise<DomainPlugin> {
		let raw: unknown
		try {
			const module: Record<string, unknown> = await import(specifier)
			raw = 'default' in module ? module.default : module
		} catch (error) {
			this.logger.error({
				actionCode: 'plugins.registry.load.unresolved',
				specifier,
				message: (error as Error).message,
			})
			throw new Error(`Plugin "${specifier}" does not resolve`)
		}

		const parsed = DomainPlugin.safeParse(raw)
		if (!parsed.success) {
			this.logger.error({
				actionCode: 'plugins.registry.load.invalid',
				specifier,
				issues: formatIssues(parsed.error),
			})
			throw new Error(`Plugin "${specifier}" does not satisfy the contract`)
		}

		return parsed.data
	}

	get(pluginId: string): DomainPlugin {
		const plugin = this.plugins.get(pluginId)
		if (!plugin) {
			throw new Error(`Plugin "${pluginId}" is not connected`)
		}
		return plugin
	}

	has(pluginId: string): boolean {
		return this.plugins.has(pluginId)
	}

	all(): DomainPlugin[] {
		return [...this.plugins.values()]
	}
}

function formatIssues(error: z.ZodError): string[] {
	return error.issues.map(
		(issue) => `${issue.path.join('.')}: ${issue.message}`,
	)
}
