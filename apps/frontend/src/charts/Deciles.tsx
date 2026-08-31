import { useState } from 'react'
import type { Decile } from '../api'
import { count, money, percent } from '../format'
import { bar } from './marks'
import { niceScale } from './scale'

const W = 460
const H = 320
// The legend lives inside the SVG, not beside it in markup: otherwise the
// chart stops being a chart once taken out of the page — and the same code
// exports it to a file for the README.
const PAD = { top: 30, right: 8, bottom: 34, left: 52 }
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }
const GAP = 2

// Cut by exposure at risk: predicted against observed frequency within each
// decile. Answers a question average metrics never see at all — does the
// error grow with position size.
export function Deciles({ deciles }: { deciles: Decile[] }) {
	const [hover, setHover] = useState<number | null>(null)

	const scale = niceScale(
		Math.max(...deciles.flatMap((d) => [d.predicted, d.observed])),
	)
	const band = PLOT.w / deciles.length
	const width = (band - GAP * 3) / 2
	const y = (value: number): number =>
		PAD.top + PLOT.h - (value / scale.max) * PLOT.h
	const height = (value: number): number => (value / scale.max) * PLOT.h

	const active = hover === null ? null : deciles[hover]

	return (
		<div>
			<div className="relative">
				<svg
					className="w-full"
					role="img"
					aria-label="Predicted and observed frequency by exposure decile"
					viewBox={`0 0 ${W} ${H}`}
				>
					{[
						{ x: PAD.left, fill: 'var(--viz-predicted)', label: 'predicted' },
						{
							x: PAD.left + 108,
							fill: 'var(--viz-observed)',
							label: 'observed',
						},
					].map((entry) => (
						<g key={entry.label}>
							<rect
								x={entry.x}
								y={6}
								width={10}
								height={10}
								rx={2}
								fill={entry.fill}
							/>
							<text x={entry.x + 16} y={15} className="fill-muted text-[10px]">
								{entry.label}
							</text>
						</g>
					))}

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
						</g>
					))}

					{deciles.map((decile, index) => {
						const left = PAD.left + index * band + GAP
						return (
							<g
								key={decile.decile}
								onMouseEnter={() => setHover(index)}
								onMouseLeave={() => setHover(null)}
							>
								<rect
									x={PAD.left + index * band}
									y={PAD.top}
									width={band}
									height={PLOT.h}
									fill="transparent"
								/>
								<path
									d={bar(
										left,
										y(decile.predicted),
										width,
										height(decile.predicted),
									)}
									fill="var(--viz-predicted)"
									opacity={hover === null || hover === index ? 1 : 0.45}
								/>
								<path
									d={bar(
										left + width + GAP,
										y(decile.observed),
										width,
										height(decile.observed),
									)}
									fill="var(--viz-observed)"
									opacity={hover === null || hover === index ? 1 : 0.45}
								/>
								<text
									x={PAD.left + index * band + band / 2}
									y={PAD.top + PLOT.h + 16}
									textAnchor="middle"
									className="fill-muted text-[10px] tabular-nums"
								>
									{decile.decile}
								</text>
							</g>
						)
					})}

					<line
						x1={PAD.left}
						x2={PAD.left + PLOT.w}
						y1={y(0)}
						y2={y(0)}
						className="stroke-border"
						strokeWidth={1}
					/>
					<text
						x={PAD.left + PLOT.w / 2}
						y={H - 4}
						textAnchor="middle"
						className="fill-muted text-[10px]"
					>
						exposure decile (1 — smallest)
					</text>
				</svg>

				{active && (
					<div
						className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-overlay"
						style={{
							left: `${((PAD.left + (hover! + 0.5) * band) / W) * 100}%`,
							top: `${((Math.min(y(active.predicted), y(active.observed)) - 10) / H) * 100}%`,
						}}
					>
						<div className="font-medium">
							decile {active.decile}: {money(active.from)} — {money(active.to)}
						</div>
						<div className="text-muted tabular-nums">
							{count(active.count)} positions, exposure {money(active.exposure)}
						</div>
						<div className="tabular-nums">
							predicted {percent(active.predicted, 3)} ·{' '}
							{money(active.predictedLoss)}
						</div>
						<div className="tabular-nums">
							observed {percent(active.observed, 3)} ·{' '}
							{money(active.realizedLoss)}
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
