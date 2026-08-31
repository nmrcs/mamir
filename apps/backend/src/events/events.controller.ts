import { BadRequestException, Body, Controller, Post } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IngestEvent, type IngestResult } from '@mamir/contracts'
import { EventsService } from './events.service'

@ApiTags('events')
@Controller('events')
export class EventsController {
	constructor(private readonly events: EventsService) {}

	// The system boundary — validation is mandatory here. The envelope is
	// checked by the contract, the payload's content — by the plugin schema
	// already in the service.
	@Post()
	ingest(@Body() body: unknown): Promise<IngestResult> {
		const parsed = IngestEvent.safeParse(body)

		if (!parsed.success) {
			throw new BadRequestException({
				message: 'Malformed request',
				issues: parsed.error.issues,
			})
		}

		return this.events.ingest(parsed.data)
	}
}
