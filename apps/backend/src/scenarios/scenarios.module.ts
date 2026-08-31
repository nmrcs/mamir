import { Module } from '@nestjs/common'
import { ExposureModule } from '../exposure/exposure.module'
import { ScoringModule } from '../scoring/scoring.module'
import { ScenariosController } from './scenarios.controller'
import { ScenariosService } from './scenarios.service'

@Module({
	imports: [ExposureModule, ScoringModule],
	controllers: [ScenariosController],
	providers: [ScenariosService],
})
export class ScenariosModule {}
