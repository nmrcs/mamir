import { Module } from '@nestjs/common'
import { ScoringModule } from '../scoring/scoring.module'
import { WindowsModule } from '../windows/windows.module'
import { EventsController } from './events.controller'
import { EventsService } from './events.service'

@Module({
	// WindowsModule and ScoringModule, unlike Prisma and Plugins, are not
	// global — they must be imported explicitly.
	imports: [WindowsModule, ScoringModule],
	controllers: [EventsController],
	providers: [EventsService],
	exports: [EventsService],
})
export class EventsModule {}
