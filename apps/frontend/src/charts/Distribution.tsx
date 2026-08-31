import { useState } from 'react'
import type { LossDistribution } from '../api'
import { count, money, percent } from '../format'
import { Stat } from '../ui'
import { bar } from './marks'
import { niceScale } from './scale'

const W = 940
const H = 300
const PAD = { top: 44, right: 12, bottom: 30, left: 50 }
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }
const GAP = 2

// A non-zero bin must be visible. The peak holds tens of thousands of paths, a
// tail bin holds a handful, and honest proportion would give it a fraction of
// a pixel: the tail would look empty exactly where it is the chart's whole
// point. A 1.5px floor keeps proportion wherever the eye can tell it apart,
// and lies less than an invisible bar.
const MIN_BAR = 1.5

// A vertical marker on the loss scale. Labels are staggered by height so that
// close markers (VaR99 and the realized 2009 loss differ by 5%) do not stick
// together; near the right edge the label flips to the left of the line.
function Marker({
	x,
	label,
	tier,
	color,
	dashed,
}: {
	x: number
	label: string
	tier: number
	color: string
	dashed?: boolean
}) {
	const flip = x > PAD.left + PLOT.w * 0.78
	return (
		<g>
			<line
				x1={x}
				x2={x}
				y1={14 + tier * 13}
				y2={PAD.top + PLOT.h}
				stroke={color}
				strokeWidth={1.5}
				strokeDasharray={dashed ? '4 3' : undefined}
			/>
			<text
				x={flip ? x - 5 : x + 5}
				y={11 + tier * 13}
				textAnchor={flip ? 'end' : 'start'}
				className="text-[10px] tabular-nums"
				fill={color}
			>
				{label}
			</text>
		</g>
	)
}

export function Distribution({ d }: { d: LossDistribution }) {
	const [hover, setHover] = useState<number | null>(null)

	const { counts, edges } = d.histogram
	const total = counts.reduce((sum, value) => sum + value, 0)
	const from = edges[0]
	const span = edges[edges.length - 1] - from

	const x = (value: number): number =>
		PAD.left + ((value - from) / span) * PLOT.w
	const scale = niceScale(Math.max(...counts) / total)
	const height = (share: number): number => (share / scale.max) * PLOT.h

	// The realized loss may fall outside the support on either side — not a
	// rendering bug but the run's main result: beyond the maximum at a ρ
	// measured before the crisis; below the minimum on an episode the model
	// badly overestimated. The line hugs the edge and turns dashed.
	const realized = d.realized
	const beyond = realized !== null && realized.value > edges[edges.length - 1]
	const below = realized !== null && realized.value < edges[0]

	const active = hover === null ? null : hover

	return (
		<div className="relative">
			<svg
				className="w-full"
				role="img"
				aria-label="Histogram of predicted portfolio losses with VaR and realized markers"
				viewBox={`0 0 ${W} ${H}`}
			>
				{scale.ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={PAD.left}
							x2={PAD.left + PLOT.w}
							y1={PAD.top + PLOT.h - height(tick)}
							y2={PAD.top + PLOT.h - height(tick)}
							className="stroke-separator"
							strokeWidth={1}
						/>
						<text
							x={PAD.left - 8}
							y={PAD.top + PLOT.h - height(tick) + 4}
							textAnchor="end"
							className="fill-muted text-[10px] tabular-nums"
						>
							{percent(tick, 0)}
						</text>
					</g>
				))}

				{counts.map((paths, index) => {
					if (paths === 0) return null
					const left = x(edges[index])
					const width = x(edges[index + 1]) - left - GAP
					const h = Math.max(height(paths / total), MIN_BAR)
					return (
						<path
							key={index}
							d={bar(left + GAP / 2, PAD.top + PLOT.h - h, width, h)}
							fill="var(--viz-predicted)"
							opacity={hover === null || hover === index ? 1 : 0.45}
						/>
					)
				})}

				<Marker
					x={x(d.var99)}
					label={`VaR 99% · ${money(d.var99)}`}
					tier={1}
					color="var(--color-muted)"
					dashed
				/>
				<Marker
					x={x(d.var999)}
					label={`VaR 99.9% · ${money(d.var999)}`}
					tier={2}
					color="var(--color-muted)"
					dashed
				/>
				{realized !== null && (
					<Marker
						x={
							beyond ? PAD.left + PLOT.w : below ? PAD.left : x(realized.value)
						}
						label={
							beyond
								? `realized ${money(realized.value)} — beyond all paths`
								: below
									? `realized ${money(realized.value)} — below all paths`
									: `realized · ${money(realized.value)}`
						}
						tier={0}
						color="var(--viz-observed)"
						dashed={beyond || below}
					/>
				)}

				{counts.map((paths, index) => (
					<rect
						key={index}
						x={x(edges[index])}
						y={PAD.top}
						width={x(edges[index + 1]) - x(edges[index])}
						height={PLOT.h}
						fill="transparent"
						onMouseEnter={() => setHover(index)}
						onMouseLeave={() => setHover(null)}
					/>
				))}

				<line
					x1={PAD.left}
					x2={PAD.left + PLOT.w}
					y1={PAD.top + PLOT.h}
					y2={PAD.top + PLOT.h}
					className="stroke-border"
					strokeWidth={1}
				/>
				{[0, 0.25, 0.5, 0.75, 1].map((share) => (
					<text
						key={share}
						x={PAD.left + PLOT.w * share}
						y={H - 8}
						textAnchor={share === 0 ? 'start' : share === 1 ? 'end' : 'middle'}
						className="fill-muted text-[10px] tabular-nums"
					>
						{money(from + span * share)}
					</text>
				))}
			</svg>

			{active !== null && counts[active] > 0 && (
				<div
					className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-overlay"
					style={{
						left: `${(((x(edges[active]) + x(edges[active + 1])) / 2 / W) * 100).toFixed(2)}%`,
						top: `${((PAD.top + 8) / H) * 100}%`,
					}}
				>
					<div className="font-medium tabular-nums">
						{money(edges[active])} — {money(edges[active + 1])}
					</div>
					<div className="text-muted tabular-nums">
						{count(counts[active])} paths ·{' '}
						{percent(
							counts[active] / total,
							counts[active] / total < 0.01 ? 2 : 1,
						)}
					</div>
				</div>
			)}
		</div>
	)
}

// The whole distribution section: stat cards, chart, parameters. Split off
// from the screen so a run without a distribution is checked by a fixture,
// not by whatever the database holds right now.
export function DistributionSection({
	distribution,
}: {
	distribution: LossDistribution | null
}) {
	if (distribution === null) {
		return (
			<p className="text-sm text-muted">
				The distribution was not computed for this run: the simulation costs
				minutes on top of portfolio assembly and is launched explicitly, via the{' '}
				<code>scenarios</code> parameter.
			</p>
		)
	}

	const worse =
		distribution.realized === null
			? null
			: Math.round(
					(1 - distribution.realized.percentile) * distribution.scenarios,
				)

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap gap-8">
				{distribution.realized !== null && worse !== null && (
					<Stat
						label="Realized percentile"
						value={percent(distribution.realized.percentile, 2)}
						hint={
							worse === 0
								? 'beyond all simulated paths'
								: `worse — ${count(worse)} of ${count(distribution.scenarios)} paths`
						}
					/>
				)}
				<Stat
					label="σ of unexpected loss"
					value={money(distribution.unexpectedLoss)}
				/>
				<Stat label="VaR 99%" value={money(distribution.var99)} />
				<Stat label="VaR 99.9%" value={money(distribution.var999)} />
				<Stat label="ES 97.5%" value={money(distribution.es975)} />
				<Stat label="Worst path" value={money(distribution.max)} />
			</div>

			<Distribution d={distribution} />

			<span className="text-xs text-muted tabular-nums">
				ρ = {distribution.rho} · {count(distribution.scenarios)} paths ·
				built-in check: analytic mean {money(distribution.expectedLoss)},
				simulated {money(distribution.simulatedMean)}
			</span>
		</div>
	)
}
