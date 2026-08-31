import { Module } from '@nestjs/common'
import { ExposureModule } from '../exposure/exposure.module'
import { ScoringModule } from '../scoring/scoring.module'
import { HistoryController } from './history.controller'
import { HistoryService } from './history.service'

@Module({
	imports: [ExposureModule, ScoringModule],
	controllers: [HistoryController],
	providers: [HistoryService],
})
export class HistoryModule {}
