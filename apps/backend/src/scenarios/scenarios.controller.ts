import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Param,
	Post,
	Query,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import {
	type ScenarioReport,
	type ScenarioRunView,
	ScenariosService,
} from './scenarios.service'

const RunBody = z.object({
	plugin: z.string().min(1),
	at: z.iso.datetime(),
	lookback: z.string().regex(/^\d+[mhd]$/),
})

interface ScenarioSummary {
	pluginId: string
	id: string
	title: string
	shock: { field: string; op: string; value: string | number | boolean }[]
}

@ApiTags('scenarios')
@Controller('scenarios')
export class ScenariosController {
	constructor(
		private readonly scenarios: ScenariosService,
		private readonly registry: PluginRegistryService,
	) {}

	// What can be run at all. The list comes from the plugin declarations — the
	// core does not invent scenarios.
	@Get()
	list(): ScenarioSummary[] {
		return this.registry.all().flatMap((plugin) =>
			plugin.scenarios.map((scenario) => ({
				pluginId: plugin.id,
				id: scenario.id,
				title: scenario.title,
				shock: scenario.shock,
			})),
		)
	}

	// Stored runs, not a recomputation: a scenario on a balance-sheet domain
	// runs for minutes and cannot be launched by opening a page.
	@Get('runs')
	runs(@Query('plugin') plugin?: string): Promise<ScenarioRunView[]> {
		return this.scenarios.runs(plugin)
	}

	@Post(':id/run')
	run(@Param('id') id: string, @Body() body: unknown): Promise<ScenarioReport> {
		const parsed = RunBody.safeParse(body)
		if (!parsed.success) {
			throw new BadRequestException({
				message: 'Malformed request',
				issues: parsed.error.issues,
			})
		}

		if (!this.registry.has(parsed.data.plugin)) {
			throw new BadRequestException(
				`Plugin "${parsed.data.plugin}" is not connected`,
			)
		}

		return this.scenarios.run({
			pluginId: parsed.data.plugin,
			scenarioId: id,
			at: new Date(parsed.data.at),
			lookback: parsed.data.lookback,
		})
	}
}
