import { Controller, Get, Param, Query } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import {
	BacktestService,
	type CaseView,
	type RunView,
} from './backtest.service'

// Reading runs. A run itself is launched from the CLI — training several
// models in a row is not a response to an HTTP request — but the result has to
// be reachable from outside: the acceptance criterion requires cases to open
// with the full feature vector as of the event.
@ApiTags('backtests')
@Controller('backtests')
export class BacktestController {
	constructor(private readonly backtest: BacktestService) {}

	@Get()
	list(@Query('plugin') plugin?: string): Promise<RunView[]> {
		return this.backtest.runs(plugin)
	}

	@Get(':id/cases')
	cases(@Param('id') id: string): Promise<CaseView[]> {
		return this.backtest.cases(id)
	}
}
