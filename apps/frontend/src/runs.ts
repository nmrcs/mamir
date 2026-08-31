import type { BacktestRun } from './api'
import { day } from './format'

export const LEGACY = 'legacy'

export interface Execution {
	key: string
	label: string
	runs: BacktestRun[]
}

// Windows are grouped by execution, not shown as one flat list: six windows of
// one `backtest` are one run, and mixing them with another execution's windows
// would compare models trained on different data. Runs made before executionId
// was introduced have no group — the label says so instead of inventing a
// grouping.
export function executions(runs: BacktestRun[]): Execution[] {
	const groups = new Map<string, BacktestRun[]>()
	for (const run of runs) {
		const key = run.executionId ?? LEGACY
		groups.set(key, [...(groups.get(key) ?? []), run])
	}

	return [...groups.entries()]
		.map(([key, group]) => {
			const sorted = [...group].sort((a, b) =>
				a.window.from.localeCompare(b.window.from),
			)
			return {
				key,
				label:
					key === LEGACY
						? `ungrouped runs — ${group.length} windows`
						: `${day(sorted[0].createdAt)} — ${group.length} windows`,
				runs: sorted,
			}
		})
		.sort((a, b) => b.runs[0].createdAt.localeCompare(a.runs[0].createdAt))
}
