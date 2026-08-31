import { Controller, Get } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { PluginRegistryService } from './plugin-registry.service'

interface PluginSummary {
	id: string
	version: string
	entities: string[]
	features: string[]
	scenarios: string[]
	// The share of the amount lost when the event happens. It travels outward
	// because every money figure in the reports is multiplied by it: an
	// assumption hidden from whoever reads the money is the same as an
	// assumption never declared at all.
	severity: number
}

@ApiTags('plugins')
@Controller('plugins')
export class PluginsController {
	constructor(private readonly registry: PluginRegistryService) {}

	// What a domain is plugged in with is visible from outside, without reading
	// logs. The same endpoint verifies the central claim: plug in a second
	// plugin, it appears here, and the core is untouched.
	@Get()
	list(): PluginSummary[] {
		return this.registry.all().map((plugin) => ({
			id: plugin.id,
			version: plugin.version,
			entities: Object.keys(plugin.entityKeys),
			features: plugin.features.map((f) => f.name),
			scenarios: plugin.scenarios.map((s) => s.id),
			severity: plugin.exposure.severity,
		}))
	}
}
