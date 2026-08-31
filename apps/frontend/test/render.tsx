import React from 'react'
// Smoke run of all four screens against the live core. The build catches types,
// but not a HeroUI component getting the wrong prop, nor a screen crashing on a
// run without weighted metrics.
import { JSDOM } from 'jsdom'

const dom = new JSDOM(
	'<!doctype html><html><body><div id="root"></div></body></html>',
	{
		url: 'http://localhost:3000',
		pretendToBeVisual: true,
	},
)

// Copy the whole window over, not one global at a time: react-aria pulls in
// NodeFilter, then SVGElement, and the list never ends.
const target = globalThis as unknown as Record<string, unknown>
for (const key of Object.getOwnPropertyNames(dom.window)) {
	if (key in globalThis) continue
	Object.defineProperty(globalThis, key, {
		get: () => (dom.window as unknown as Record<string, unknown>)[key],
		configurable: true,
	})
}
for (const [key, value] of [
	['window', dom.window],
	['document', dom.window.document],
	['navigator', dom.window.navigator],
] as const) {
	Object.defineProperty(globalThis, key, { value, configurable: true })
}
target.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
}
// jsdom does not implement Web Animations — the tab transition relies on them.
// Unrelated to the data.
dom.window.Element.prototype.getAnimations = () => []
dom.window.Element.prototype.scrollTo = () => {}
target.IS_REACT_ACT_ENVIRONMENT = true

// The core must be up: the showcase reads live runs. An explicit GET /health
// check gives a clear error instead of a "not found: MAMIR" after timeouts.
try {
	await fetch('http://localhost:3001/health')
} catch {
	throw new Error(
		'the core does not answer on :3001 — npm run dev -w @mamir/backend',
	)
}

const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { BrowserRouter } = await import('react-router-dom')
const { App } = await import('../src/App')

const root = createRoot(dom.window.document.getElementById('root')!)

await act(async () => {
	root.render(
		<BrowserRouter>
			<App />
		</BrowserRouter>,
	)
})

const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
		})
	}
}

await settle()

const text = (): string => dom.window.document.body.textContent ?? ''
const expect = (needle: string): void => {
	if (!text().includes(needle)) {
		throw new Error(`not found on the page: ${needle}`)
	}
}

expect('MAMIR')
expect('Drift across windows')
expect('Metrics by window')
expect('Calibration curve')
console.log('metrics: ok')

// A tab changes the URL, not just state — otherwise the router is pointless here.
const open = async (label: string, path: string): Promise<void> => {
	const tab = [...dom.window.document.querySelectorAll('[role="tab"]')].find(
		(node) => node.textContent?.trim() === label,
	)
	if (tab === undefined) throw new Error(`no ${label} tab`)
	await act(async () => {
		;(tab as HTMLElement).click()
	})
	await settle()
	if (dom.window.location.pathname !== path) {
		throw new Error(
			`the address did not change: expected ${path}, got ${dom.window.location.pathname}`,
		)
	}
}

await open('Cases', '/cases')
expect('Caught')
// A miss is shown on par with a catch — a project rule, not styling.
expect('Miss')
expect('False alarm')
console.log('cases: ok')

await open('Stress', '/stress')
expect('Scenario runs')
expect('Extrapolation')
console.log('stress: ok')

await open('History', '/history')
expect('Checked against history')
expect('Gap by decile')
// Card title only: whether the latest run has a distribution is database
// state; the numbers are checked by the fixture below.
expect('Loss distribution')
console.log('history: ok')

// Second domain: it has its own time scale (relative, 1970), so the year in
// the table is the proof that the switch reached the data.
const pick = async (domain: string): Promise<void> => {
	const trigger = dom.window.document.querySelector(
		'[data-slot="select-trigger"]',
	)
	if (trigger === null) throw new Error('no domain selector')
	await act(async () => {
		;(trigger as HTMLElement).click()
	})
	await settle()
	const option = [
		...dom.window.document.querySelectorAll('[role="option"]'),
	].find((node) => node.textContent?.includes(domain))
	if (option === undefined) throw new Error(`no ${domain} domain`)
	await act(async () => {
		;(option as HTMLElement).click()
	})
	await settle()
}

await open('Metrics', '/metrics')
await pick('payment_fraud')
expect('Metrics by window')
expect('1970-')

// Remaining tabs of the second domain: whether the DB holds runs is database
// state, so the live check accepts both data and an honest empty state.
// A crashed screen shows neither — that is what we catch.
const anyOf = (...needles: string[]): void => {
	if (!needles.some((needle) => text().includes(needle))) {
		throw new Error(`none of these found: ${needles.join(' · ')}`)
	}
}

await open('Cases', '/cases')
anyOf('Caught', 'no saved backtest runs')
await open('Stress', '/stress')
anyOf('Scenario runs', 'has been run on this domain yet')
await open('History', '/history')
anyOf('Checked against history', 'has been run on this domain')
console.log('second domain: ok')

// A run without weighted metrics — on a fixture, not on whatever the database
// holds now: tying the check to DB state makes it hostage to the next re-run.
const { Metrics } = await import('../src/screens/Metrics')
const legacy = {
	id: 'fixture',
	pluginId: 'fixture',
	executionId: null,
	window: { from: '2005-01-01T00:00:00.000Z', to: '2006-01-01T00:00:00.000Z' },
	model: {
		id: 'fixture-model',
		trainWindowEnd: '2005-01-01T00:00:00.000Z',
		calibration: 'isotonic',
	},
	metrics: {
		brier: 0.0045,
		logLoss: 0.0212,
		rocAuc: 0.9347,
		prAuc: 0.3298,
		ece: 0.00206,
		positiveRate: 0.00579,
	},
	reliability: [],
	deciles: [],
	cases: 0,
	createdAt: '2026-01-01T00:00:00.000Z',
}
const group = {
	key: 'legacy',
	label: 'ungrouped runs — 1 windows',
	runs: [legacy],
}

const fixture = dom.window.document.createElement('div')
dom.window.document.body.appendChild(fixture)
await act(async () => {
	createRoot(fixture).render(
		<Metrics
			groups={[group]}
			group={group}
			run={legacy}
			onExecution={() => {}}
			onRun={() => {}}
		/>,
	)
})
await settle()
if (!fixture.textContent?.includes('—')) {
	throw new Error('an unweighted metric is shown as a number instead of a dash')
}
if (!fixture.textContent?.includes('predates the decile cut')) {
	throw new Error('empty deciles are not explained')
}
console.log('run without weighted metrics: ok')

// Loss distribution — both branches on a fixture. Numbers from take 38 (2009,
// ρ = 0.15), the histogram cut down to five bins: what is checked is that the
// values reach the markup, not the simulation itself — the sidecar's tests
// cover that.
const { DistributionSection } = await import('../src/charts/Distribution')
const distribution = {
	expectedLoss: 161_400_000,
	simulatedMean: 161_300_000,
	unexpectedLoss: 115_700_000,
	var99: 577_600_000,
	var999: 909_900_000,
	es975: 594_600_000,
	max: 1_708_300_000,
	scenarios: 50_000,
	rho: 0.15,
	realized: { value: 546_400_000, percentile: 0.98706 },
	histogram: {
		counts: [38_000, 9_000, 2_400, 550, 50],
		edges: [
			0, 350_000_000, 700_000_000, 1_050_000_000, 1_400_000_000, 1_750_000_000,
		],
	},
}

const tail = dom.window.document.createElement('div')
dom.window.document.body.appendChild(tail)
await act(async () => {
	createRoot(tail).render(<DistributionSection distribution={distribution} />)
})
await settle()
// Intl en-US numbers come with comma separators — the needle must match.
for (const needle of ['98.71%', 'VaR 99.9%', '909.9M', '50,000 paths']) {
	if (!tail.textContent?.includes(needle)) {
		throw new Error(`the distribution did not reach the markup: ${needle}`)
	}
}

const missing = dom.window.document.createElement('div')
dom.window.document.body.appendChild(missing)
await act(async () => {
	createRoot(missing).render(<DistributionSection distribution={null} />)
})
await settle()
if (!missing.textContent?.includes('was not computed')) {
	throw new Error('a run without a distribution is not explained')
}
console.log('loss distribution: ok')

// Direct deep link: this is why the router is in the dependencies at all.
await act(async () => {
	root.unmount()
})
dom.window.history.pushState({}, '', '/stress')
const container = dom.window.document.createElement('div')
dom.window.document.body.appendChild(container)
const deep = createRoot(container)
await act(async () => {
	deep.render(
		<BrowserRouter>
			<App />
		</BrowserRouter>,
	)
})
await settle()
expect('Scenario runs')
console.log('direct link /stress: ok')

console.log('ok')
process.exit(0)
