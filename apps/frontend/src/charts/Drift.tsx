import { useState } from 'react'
import type { BacktestRun } from '../api'
import { day, fixed, measured } from '../format'
import { niceScale } from './scale'

const W = 940
const H = 250
const PAD = { top: 30, right: 12, bottom: 28, left: 52 }
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }

// Metric drift across walk-forward windows. Two panels instead of one with a
// dual axis: ranking and probability error live in different units, and a
// shared scale for them is a lie. Which panel to show is picked by the toggle
// in the card header (Metrics.tsx) — here is drawing only. Skew
// (weighted/plain) is deliberately not drawn as a line: on a domain where the
// model does not discriminate it is a ratio of two near-zeros (×31 on the
// synthetic data) and as a curve it would read as a signal. As a number in
// the tooltip it is safe.
export type DriftPanel = 'ece' | 'roc'

function path(points: { x: number; y: number }[]): string {
	return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

export function Drift({
	panel,
	runs,
	selected,
	onSelect,
}: {
	panel: DriftPanel
	runs: BacktestRun[]
	selected: string
	onSelect: (id: string) => void
}) {
	const [hover, setHover] = useState<number | null>(null)

	const band = PLOT.w / runs.length
	const x = (index: number): number => PAD.left + (index + 0.5) * band

	// ROC: the scale floor is 0.5 (random), not zero: the distance to random is
	// the metric's content. Points below 0.5 (null domain) stretch the scale.
	const rocLow =
		Math.floor(Math.min(0.5, ...runs.map((run) => run.metrics.rocAuc)) * 10) /
		10
	const rocY = (value: number): number =>
		PAD.top + PLOT.h - ((value - rocLow) / (1 - rocLow)) * PLOT.h
	const rocTicks: number[] = []
	for (let tick = rocLow; tick <= 1.001; tick += 0.1)
		rocTicks.push(Math.round(tick * 10) / 10)

	const eceScale = niceScale(
		Math.max(
			...runs.flatMap((run) => [run.metrics.ece, run.metrics.eceWeighted ?? 0]),
		),
	)
	const eceY = (value: number): number =>
		PAD.top + PLOT.h - (value / eceScale.max) * PLOT.h

	const weighted = runs
		.map((run, index) => ({ index, value: run.metrics.eceWeighted }))
		.filter(
			(point): point is { index: number; value: number } =>
				point.value !== undefined,
		)

	const active = hover === null ? null : runs[hover]

	const grid = (
		ticks: number[],
		y: (value: number) => number,
		label: (tick: number) => string,
	) =>
		ticks.map((tick) => (
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
					{label(tick)}
				</text>
			</g>
		))

	const xLabels = runs.map((run, index) => (
		<text
			key={run.id}
			x={x(index)}
			y={H - 8}
			textAnchor="middle"
			className="fill-muted text-[10px] tabular-nums"
		>
			{run.window.from.slice(0, 7)}
		</text>
	))

	// Dots are clickable and select a window — like the table rows below; the
	// hover band is wider than the dot, no need to hit an 8px circle.
	const bands = runs.map((run, index) => (
		<rect
			key={run.id}
			x={PAD.left + index * band}
			y={PAD.top}
			width={band}
			height={PLOT.h}
			fill="transparent"
			className="cursor-pointer"
			onMouseEnter={() => setHover(index)}
			onMouseLeave={() => setHover(null)}
			onClick={() => onSelect(run.id)}
		/>
	))

	const dot = (
		cx: number,
		cy: number,
		fill: string,
		run: BacktestRun,
		index: number,
	) => (
		<circle
			key={run.id}
			cx={cx}
			cy={cy}
			r={run.id === selected ? 5 : 4}
			fill={fill}
			stroke={run.id === selected ? 'var(--color-foreground)' : 'none'}
			strokeWidth={1.5}
			opacity={hover === null || hover === index ? 1 : 0.45}
		/>
	)

	const tooltip = active !== null && hover !== null && (
		<div
			className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-overlay"
			style={{
				left: `${((x(hover) / W) * 100).toFixed(2)}%`,
				top: `${((PAD.top + 8) / H) * 100}%`,
			}}
		>
			<div className="font-medium tabular-nums">
				{day(active.window.from)} → {day(active.window.to)}
			</div>
			<div className="text-muted tabular-nums">
				ROC-AUC {fixed(active.metrics.rocAuc, 3)}
			</div>
			<div className="text-muted tabular-nums">
				ECE {fixed(active.metrics.ece, 5)} · weighted{' '}
				{measured(active.metrics.eceWeighted, (value) => fixed(value, 5))}
			</div>
			<div className="text-muted tabular-nums">
				skew{' '}
				{measured(
					active.metrics.eceWeighted,
					(value) => `×${(value / active.metrics.ece).toFixed(2)}`,
				)}
			</div>
		</div>
	)

	if (panel === 'roc') {
		return (
			<div className="relative">
				<svg
					className="w-full"
					role="img"
					aria-label="ROC-AUC across backtest windows"
					viewBox={`0 0 ${W} ${H}`}
				>
					{grid(rocTicks, rocY, (tick) => tick.toFixed(1))}

					<line
						x1={PAD.left}
						x2={PAD.left + PLOT.w}
						y1={rocY(0.5)}
						y2={rocY(0.5)}
						stroke="var(--color-muted)"
						strokeWidth={1}
						strokeDasharray="4 3"
					/>
					<text
						x={PAD.left + PLOT.w}
						y={rocY(0.5) - 5}
						textAnchor="end"
						className="fill-muted text-[10px]"
					>
						random
					</text>

					<path
						d={path(
							runs.map((run, index) => ({
								x: x(index),
								y: rocY(run.metrics.rocAuc),
							})),
						)}
						fill="none"
						stroke="var(--viz-predicted)"
						strokeWidth={2}
					/>
					{runs.map((run, index) =>
						dot(
							x(index),
							rocY(run.metrics.rocAuc),
							'var(--viz-predicted)',
							run,
							index,
						),
					)}

					{xLabels}
					{bands}
				</svg>
				{tooltip}
			</div>
		)
	}

	return (
		<div className="relative">
			<svg
				className="w-full"
				role="img"
				aria-label="Calibration error across backtest windows, per event and weighted by exposure"
				viewBox={`0 0 ${W} ${H}`}
			>
				{[
					{
						x: PAD.left,
						fill: 'var(--viz-predicted)',
						label: 'ECE per event',
					},
					{
						x: PAD.left + 118,
						fill: 'var(--viz-observed)',
						label: 'weighted by exposure',
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

				{grid(eceScale.ticks, eceY, (tick) =>
					parseFloat(tick.toFixed(6)).toString(),
				)}

				<path
					d={path(
						runs.map((run, index) => ({
							x: x(index),
							y: eceY(run.metrics.ece),
						})),
					)}
					fill="none"
					stroke="var(--viz-predicted)"
					strokeWidth={2}
				/>
				{weighted.length > 0 && (
					<path
						d={path(
							weighted.map((point) => ({
								x: x(point.index),
								y: eceY(point.value),
							})),
						)}
						fill="none"
						stroke="var(--viz-observed)"
						strokeWidth={2}
					/>
				)}
				{runs.map((run, index) =>
					dot(
						x(index),
						eceY(run.metrics.ece),
						'var(--viz-predicted)',
						run,
						index,
					),
				)}
				{weighted.map((point) =>
					dot(
						x(point.index),
						eceY(point.value),
						'var(--viz-observed)',
						runs[point.index],
						point.index,
					),
				)}

				{xLabels}
				{bands}
			</svg>
			{tooltip}
		</div>
	)
}
