import { useState } from 'react'
import type { ReliabilityBin } from '../api'
import { count, fixed, percent } from '../format'
import { niceScale } from './scale'

const W = 460
const H = 320
const PAD = { top: 14, right: 18, bottom: 38, left: 52 }
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }

// Calibration curve: promised probability against observed frequency. One
// series — no legend, the card title names it. The diagonal is not a series
// but a reference line: a perfectly calibrated model lies on it.
export function Reliability({ bins }: { bins: ReliabilityBin[] }) {
	const [hover, setHover] = useState<number | null>(null)

	// One scale for both axes: they measure the same thing — probability — and
	// diverging axes would make the diagonal a lie.
	const scale = niceScale(
		Math.max(...bins.flatMap((b) => [b.predicted, b.observed])),
	)
	const x = (value: number): number => PAD.left + (value / scale.max) * PLOT.w
	const y = (value: number): number =>
		PAD.top + PLOT.h - (value / scale.max) * PLOT.h

	const path = bins
		.map((b, i) => `${i === 0 ? 'M' : 'L'} ${x(b.predicted)} ${y(b.observed)}`)
		.join(' ')

	const active = hover === null ? null : bins[hover]

	return (
		<div className="relative">
			<svg
				className="w-full"
				role="img"
				aria-label="Calibration curve: predicted probability against observed frequency"
				viewBox={`0 0 ${W} ${H}`}
			>
				{scale.ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={PAD.left}
							x2={PAD.left + PLOT.w}
							y1={y(tick)}
							y2={y(tick)}
							className="stroke-separator"
							strokeWidth={1}
						/>
						<text
							x={PAD.left - 8}
							y={y(tick) + 4}
							textAnchor="end"
							className="fill-muted text-[10px] tabular-nums"
						>
							{percent(tick, 1)}
						</text>
						<text
							x={x(tick)}
							y={PAD.top + PLOT.h + 16}
							textAnchor="middle"
							className="fill-muted text-[10px] tabular-nums"
						>
							{percent(tick, 1)}
						</text>
					</g>
				))}

				<line
					x1={x(0)}
					y1={y(0)}
					x2={x(scale.max)}
					y2={y(scale.max)}
					className="stroke-muted"
					strokeWidth={1}
					strokeDasharray="4 4"
				/>
				{/* Under the diagonal at the right edge, not at its end: the curve
				    ends there, and the label would land right on the last points. */}
				<text
					x={PAD.left + PLOT.w - 4}
					y={PAD.top + PLOT.h - 8}
					textAnchor="end"
					className="fill-muted text-[10px]"
				>
					perfect calibration
				</text>

				<path
					d={path}
					fill="none"
					strokeWidth={2}
					stroke="var(--viz-observed)"
					strokeLinejoin="round"
				/>
				{bins.map((bin, index) => (
					<circle
						key={bin.bin}
						cx={x(bin.predicted)}
						cy={y(bin.observed)}
						r={hover === index ? 7 : 5}
						fill="var(--viz-observed)"
						className="stroke-surface"
						strokeWidth={2}
					/>
				))}

				{/* Hover target larger than the dot: 5px cannot be hit with a mouse. */}
				{bins.map((bin, index) => (
					<circle
						key={`hit-${bin.bin}`}
						cx={x(bin.predicted)}
						cy={y(bin.observed)}
						r={14}
						fill="transparent"
						onMouseEnter={() => setHover(index)}
						onMouseLeave={() => setHover(null)}
					/>
				))}

				<text
					x={PAD.left + PLOT.w / 2}
					y={H - 4}
					textAnchor="middle"
					className="fill-muted text-[10px]"
				>
					predicted
				</text>
				<text
					x={12}
					y={PAD.top + PLOT.h / 2}
					textAnchor="middle"
					transform={`rotate(-90 12 ${PAD.top + PLOT.h / 2})`}
					className="fill-muted text-[10px]"
				>
					observed
				</text>
			</svg>

			{active && (
				<div
					className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-overlay"
					style={{
						left: `${(x(active.predicted) / W) * 100}%`,
						top: `${((y(active.observed) - 12) / H) * 100}%`,
					}}
				>
					<div className="font-medium">
						bin {percent(active.from, 1)}–{percent(active.to, 1)}
					</div>
					<div className="text-muted tabular-nums">
						events {count(active.count)}
					</div>
					<div className="tabular-nums">
						predicted {percent(active.predicted, 3)}
					</div>
					<div className="tabular-nums">
						observed {percent(active.observed, 3)}
					</div>
					<div className="text-muted tabular-nums">
						Kupiec LR {fixed(active.kupiecLR, 2)}
					</div>
				</div>
			)}
		</div>
	)
}
