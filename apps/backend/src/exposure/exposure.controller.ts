import { BadRequestException, Controller, Get, Query } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { type ExposureReport, ExposureService } from './exposure.service'

// The moment is mandatory. There is deliberately no "now" default: for
// historical data "now" is the year 2025, the portfolio there is empty, and
// instead of an error the user would get zeros.
const Query_ = z.object({
	plugin: z.string().min(1),
	at: z.iso.datetime(),
	lookback: z.string().regex(/^\d+[mhd]$/),
	top: z.coerce.number().int().positive().default(100),
})

@ApiTags('exposure')
@Controller('exposure')
export class ExposureController {
	constructor(
		private readonly exposure: ExposureService,
		private readonly registry: PluginRegistryService,
	) {}

	@Get()
	report(@Query() query: unknown): Promise<ExposureReport> {
		const parsed = Query_.safeParse(query)
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

		return this.exposure.report({
			pluginId: parsed.data.plugin,
			at: new Date(parsed.data.at),
			lookback: parsed.data.lookback,
			top: parsed.data.top,
		})
	}
}
