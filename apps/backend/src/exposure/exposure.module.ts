import { Module } from '@nestjs/common'
import { ScoringModule } from '../scoring/scoring.module'
import { ExposureController } from './exposure.controller'
import { ExposureService } from './exposure.service'

@Module({
	imports: [ScoringModule],
	controllers: [ExposureController],
	providers: [ExposureService],
	exports: [ExposureService],
})
export class ExposureModule {}
