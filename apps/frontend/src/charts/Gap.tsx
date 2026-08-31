import type { HistoryRun } from '../api'
import { count, money, ratio } from '../format'
import { bar } from './marks'

const W = 940
const H = 260
const PAD = { top: 34, right: 12, bottom: 34, left: 12 }
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }
const BAR = 120
const GAP = 56
// Headroom above the taller bar: the value label sits on top of it, and
// without the gap it would be clipped by the viewBox.
const HEADROOM = 1.18

// Money and counts cannot share an axis, so each pair gets its own panel and
// its own scale. Comparing them is the point: the gap in money is wider than
// the gap in counts, which is what says the error sits on the large positions.
function Pair({
	x,
	title,
	predicted,
	realized,
	format,
}: {
	x: number
	title: string
	predicted: number
	realized: number
	format: (value: number) => string
}) {
	const panel = PLOT.w / 2
	const base = PAD.top + PLOT.h
	const max = Math.max(predicted, realized) * HEADROOM
	const height = (value: number): number => (value / max) * PLOT.h
	const left = x + (panel - (BAR * 2 + GAP)) / 2
	const right = left + BAR + GAP
	const predictedTop = base - height(predicted)
	const realizedTop = base - height(realized)

	return (
		<g>
			<text
				x={x + panel / 2}
				y={14}
				textAnchor="middle"
				className="fill-muted text-[10px]"
			>
				{title}
			</text>

			<path
				d={bar(left, predictedTop, BAR, height(predicted))}
				fill="var(--viz-predicted)"
			/>
			<path
				d={bar(right, realizedTop, BAR, height(realized))}
				fill="var(--viz-observed)"
			/>

			{/* The predicted level continued across the panel: the gap is then a
			    distance on the chart, not two numbers the reader has to divide. */}
			<line
				x1={left}
				x2={right + BAR}
				y1={predictedTop}
				y2={predictedTop}
				className="stroke-muted"
				strokeWidth={1}
				strokeDasharray="3 3"
			/>

			<text
				x={left + BAR / 2}
				y={predictedTop - 8}
				textAnchor="middle"
				className="fill-muted text-[10px] tabular-nums"
			>
				{format(predicted)}
			</text>
			<text
				x={right + BAR / 2}
				y={realizedTop - 8}
				textAnchor="middle"
				fill="var(--viz-observed)"
				className="text-[10px] tabular-nums"
				fontSize={13}
			>
				{format(realized)}
			</text>

			<text
				x={right + BAR + 10}
				y={realizedTop + (predictedTop - realizedTop) / 2}
				className="fill-muted text-[10px] tabular-nums"
				fontSize={13}
			>
				{ratio(realized / predicted)}
			</text>

			<text
				x={left + BAR / 2}
				y={base + 16}
				textAnchor="middle"
				className="fill-muted text-[10px]"
			>
				predicted
			</text>
			<text
				x={right + BAR / 2}
				y={base + 16}
				textAnchor="middle"
				className="fill-muted text-[10px]"
			>
				realized
			</text>
		</g>
	)
}

// What the portfolio layer answers and no event metric does: the model
// promised this much loss, that much happened. The counts panel stands beside
// it because the two gaps differ — the difference is a second, separate error.
export function Gap({ run }: { run: HistoryRun }) {
	return (
		<svg
			className="w-full"
			role="img"
			aria-label="Predicted against realized portfolio loss and default counts"
			viewBox={`0 0 ${W} ${H}`}
		>
			<Pair
				x={PAD.left}
				title="loss, $"
				predicted={run.predictedEL}
				realized={run.realizedLoss}
				format={money}
			/>
			<Pair
				x={PAD.left + PLOT.w / 2}
				title="defaults, positions"
				predicted={run.expectedPositives}
				realized={run.observedPositives}
				format={count}
			/>

			<line
				x1={PAD.left}
				x2={PAD.left + PLOT.w}
				y1={PAD.top + PLOT.h}
				y2={PAD.top + PLOT.h}
				className="stroke-border"
				strokeWidth={1}
			/>
		</svg>
	)
}
