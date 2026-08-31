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
	type HistoryReport,
	type HistoryRunView,
	HistoryService,
} from './history.service'

// The moment is deliberately absent from the body: it is part of a named
// episode, not a request parameter. Letting it be set from outside would mean
// letting someone pick the date on which the model looks better.
const RunBody = z.object({
	plugin: z.string().min(1),
	lookback: z.string().regex(/^\d+[mhd]$/),
	// The number of simulation paths for the loss distribution; without it the
	// run compares means only. The ceiling is aligned with the core→sidecar
	// transport budget.
	scenarios: z.coerce.number().int().min(1000).max(200_000).optional(),
	seed: z.coerce.number().int().default(20260807),
	// A correlation override for one run — the sensitivity knob. The moment
	// cannot be picked, but ρ can and should be: it is the least reliable
	// parameter in the system, and a report at several values is the measure of
	// how much the conclusion can be trusted. The value used is stored with the
	// run itself.
	rho: z.coerce.number().min(0).lt(1).optional(),
})

interface HistorySummary {
	pluginId: string
	id: string
	title: string
	at: string
}

@ApiTags('history')
@Controller('history')
export class HistoryController {
	constructor(
		private readonly history: HistoryService,
		private readonly registry: PluginRegistryService,
	) {}

	@Get()
	list(): HistorySummary[] {
		return this.registry.all().flatMap((plugin) =>
			plugin.history.map((episode) => ({
				pluginId: plugin.id,
				id: episode.id,
				title: episode.title,
				at: episode.at,
			})),
		)
	}

	// Stored runs, not a recomputation: assembling the portfolio again costs
	// minutes.
	@Get('runs')
	runs(@Query('plugin') plugin?: string): Promise<HistoryRunView[]> {
		return this.history.runs(plugin)
	}

	@Post(':id/run')
	run(@Param('id') id: string, @Body() body: unknown): Promise<HistoryReport> {
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

		return this.history.run({
			pluginId: parsed.data.plugin,
			scenarioId: id,
			lookback: parsed.data.lookback,
			scenarios: parsed.data.scenarios,
			seed: parsed.data.seed,
			rho: parsed.data.rho,
		})
	}
}
