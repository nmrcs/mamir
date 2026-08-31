import { Module } from '@nestjs/common'
import { DatasetModule } from '../dataset/dataset.module'
import { BacktestController } from './backtest.controller'
import { BacktestService } from './backtest.service'

@Module({
	imports: [DatasetModule],
	controllers: [BacktestController],
	providers: [BacktestService],
	exports: [BacktestService],
})
export class BacktestModule {}
