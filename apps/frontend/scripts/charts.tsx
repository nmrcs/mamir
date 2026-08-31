// Report charts — the same code that draws them in the showcase. There is no
// second definition of the calibration curve: the README image and the
// on-screen chart cannot diverge by construction.
//
//   npm run charts -w @mamir/frontend
//
// Data comes from the core's saved runs, not from a file of numbers: what is
// printed in the README must be the same as what sits in the database.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BacktestRun, HistoryRun } from '../src/api'
import { Deciles } from '../src/charts/Deciles'
import { Distribution } from '../src/charts/Distribution'
import { Drift } from '../src/charts/Drift'
import { Gap } from '../src/charts/Gap'
import { Reliability } from '../src/charts/Reliability'

const BASE = 'http://localhost:3001'
const OUT = resolve(import.meta.dirname, '../../../reports')

// Outside the app there are no Tailwind classes, so the chart chrome ships as
// a style inside the file itself. The dark half is mandatory: GitHub renders
// the README in the reader's theme, and a light-background image in a dark
// theme looks like a hole.
const STYLE = `
:root { --viz-predicted: #2a78d6; --viz-observed: #eb6834; --color-muted: #898781; }
svg { background: #fcfcfb; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
text { font-size: 10px; font-variant-numeric: tabular-nums; }
.fill-muted { fill: #898781 }
.stroke-muted { stroke: #898781 }
.stroke-separator { stroke: #e1e0d9 }
.stroke-border { stroke: #c3c2b7 }
.stroke-surface { stroke: #fcfcfb }
@media (prefers-color-scheme: dark) {
  :root { --viz-predicted: #3987e5; --viz-observed: #d95926; --color-muted: #8f8d87; }
  svg { background: #1a1a19 }
  .stroke-separator { stroke: #2c2c2a }
  .stroke-border { stroke: #383835 }
  .stroke-surface { stroke: #1a1a19 }
}
`.trim()

// The component returns a wrapper with a tooltip — only the chart itself goes
// into the file. A standalone file needs what the page markup does not: xmlns
// (browsers refuse to render without it), a size (on the page a Tailwind class
// set it) and an inline style (outside the app there are no classes).
const standalone = (markup: string, w: number, h: number): string => {
	const from = markup.indexOf('<svg')
	const to = markup.lastIndexOf('</svg>') + '</svg>'.length
	return markup
		.slice(from, to)
		.replace(
			/^<svg /,
			`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" `,
		)
		.replace(/^(<svg[^>]*>)/, `$1<style>${STYLE}</style>`)
}

const write = async (
	name: string,
	markup: string,
	size: { w: number; h: number },
): Promise<void> => {
	const svg = standalone(markup, size.w, size.h)
	const path = resolve(OUT, name)
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`)
	console.log(`${name} — ${svg.length} bytes`)
}

const response = await fetch(`${BASE}/backtests?plugin=credit_risk`)
if (!response.ok) {
	throw new Error(
		`the core did not respond (${response.status}). Start it: npm run dev -w @mamir/backend`,
	)
}
const runs = (await response.json()) as BacktestRun[]

// Crisis window of the latest execution. Runs without an executionId are
// excluded: there is nothing to tell which execution they came from.
const latest = runs
	.filter((run) => run.executionId !== null)
	.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.executionId
const crisis = runs.find(
	(run) =>
		run.executionId === latest && run.window.from.startsWith('2009-01-01'),
)

if (crisis === undefined) {
	throw new Error(
		'no run of the 2009 window with a recorded executionId in the database',
	)
}

console.log(
	`window ${crisis.window.from.slice(0, 10)} → ${crisis.window.to.slice(0, 10)}, model ${crisis.model.id}`,
)

await write(
	'calibration-2009.svg',
	renderToStaticMarkup(<Reliability bins={crisis.reliability} />),
	{ w: 460, h: 320 },
)
await write(
	'deciles-2009.svg',
	renderToStaticMarkup(<Deciles deciles={crisis.deciles} />),
	{ w: 460, h: 320 },
)

// Calibration error drift across windows: plain and exposure-weighted ECE,
// the weighted one crossing above the plain one on the 2007 window. Windows of
// one execution only — mixing executionIds would splice the line from
// different models.
const windows = runs
	.filter((run) => run.executionId === latest)
	.sort((a, b) => a.window.from.localeCompare(b.window.from))

await write(
	'calibration-drift.svg',
	renderToStaticMarkup(
		<Drift panel="ece" runs={windows} selected="" onSelect={() => {}} />,
	),
	{ w: 940, h: 250 },
)

// Loss distribution of an episode at the named ρ. Runs with other ρ sit in
// the same table as a sensitivity range, but the README image shows the
// report's primary point.
const distributionChart = async (
	plugin: string,
	scenarioId: string,
	rho: number,
	name: string,
): Promise<HistoryRun> => {
	const history = (await (
		await fetch(`${BASE}/history/runs?plugin=${plugin}`)
	).json()) as HistoryRun[]
	const episode = history.find(
		(run) =>
			run.scenarioId === scenarioId &&
			run.distribution !== null &&
			run.distribution.rho === rho &&
			run.distribution.scenarios >= 50_000,
	)
	if (episode === undefined || episode.distribution === null) {
		throw new Error(
			`no ${scenarioId} run with a distribution at ρ = ${rho} in the database`,
		)
	}
	await write(
		name,
		renderToStaticMarkup(<Distribution d={episode.distribution} />),
		{ w: 940, h: 300 },
	)
	return episode
}

// The credit domain's crisis at the Basel-prescribed ρ — and the null domain's
// control month at a declared ρ = 0: the "sees the crisis / invents no crisis"
// pair is drawn by one piece of code.
const crisis2009 = await distributionChart(
	'credit_risk',
	'crisis_2009',
	0.15,
	'distribution-2009.svg',
)
await distributionChart(
	'payment_fraud',
	'control_month',
	0,
	'distribution-control.svg',
)

// Predicted against realized loss for the same episode — the pair the whole
// portfolio layer exists for. It comes from the run that drew the histogram
// above, not from a second lookup: one episode, one set of numbers.
await write(
	'portfolio-gap-2009.svg',
	renderToStaticMarkup(<Gap run={crisis2009} />),
	{ w: 940, h: 260 },
)
