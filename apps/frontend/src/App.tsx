import { Spinner, Tabs } from '@heroui/react'
import { useState } from 'react'
import {
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from 'react-router-dom'
import type { BacktestRun, Plugin } from './api'
import { useApi } from './api'
import { executions } from './runs'
import { Cases } from './screens/Cases'
import { History } from './screens/History'
import { Metrics } from './screens/Metrics'
import { Stress } from './screens/Stress'
import { Picker } from './ui'

const TABS = [
	{ id: 'metrics', label: 'Metrics' },
	{ id: 'cases', label: 'Cases' },
	{ id: 'stress', label: 'Stress' },
	{ id: 'history', label: 'History' },
] as const

// Backtest runs live here, not inside Metrics: the window is picked there but
// read on Cases, and two requests for one list would drift apart.
export function App() {
	const location = useLocation()
	const navigate = useNavigate()
	const plugins = useApi<Plugin[]>('/plugins')
	const [pluginId, setPluginId] = useState<string | null>(null)
	const [execution, setExecution] = useState<string | null>(null)
	const [runId, setRunId] = useState<string | null>(null)

	const plugin =
		plugins.data?.find((item) => item.id === pluginId) ?? plugins.data?.[0]
	const backtests = useApi<BacktestRun[]>(
		plugin === undefined ? null : `/backtests?plugin=${plugin.id}`,
	)

	if (plugins.error !== null || backtests.error !== null) {
		return (
			<main className="mx-auto max-w-2xl px-6 py-24 text-center">
				<h1 className="text-xl font-medium">The core is not responding</h1>
				<p className="mt-2 text-sm text-muted">
					{plugins.error ?? backtests.error}
				</p>
				<p className="mt-4 text-sm text-muted">
					Start it: <code>npm run dev -w @mamir/backend</code>
				</p>
			</main>
		)
	}

	if (plugin === undefined || backtests.data === null) {
		return (
			<main className="flex justify-center py-24">
				<Spinner />
			</main>
		)
	}

	const groups = executions(backtests.data)
	const group = groups.find((item) => item.key === execution) ?? groups[0]
	const run =
		group === undefined
			? undefined
			: (group.runs.find((item) => item.id === runId) ?? group.runs[0])

	const tab =
		TABS.find((item) => location.pathname.startsWith(`/${item.id}`))?.id ??
		'metrics'

	// Runs belong to a domain: keys left over from the previous plugin would
	// open another domain's windows and cases.
	const selectPlugin = (next: string): void => {
		setPluginId(next)
		setExecution(null)
		setRunId(null)
	}

	const selectExecution = (next: string): void => {
		setExecution(next)
		setRunId(null)
	}

	return (
		<div className="min-h-screen bg-background text-foreground">
			<header className="border-b border-separator">
				<div className="mx-auto max-w-[1400px] px-6">
					<div className="flex flex-wrap items-end justify-between gap-6 py-6">
						<div>
							<h1 className="text-2xl font-medium">MAMIR</h1>
							<p className="mt-1 max-w-2xl text-sm text-muted">
								The core knows no domain words. Everything below is one engine
								running a plugin declaration: {plugin.features.length} features,{' '}
								{plugin.scenarios.length} scenarios, axes{' '}
								{plugin.entities.join(', ')}.
							</p>
						</div>
						<Picker
							label="Domain"
							items={plugins.data ?? []}
							value={plugin.id}
							onChange={selectPlugin}
							id={(item) => item.id}
							title={(item) => `${item.id} ${item.version}`}
						/>
					</div>

					<nav>
						<Tabs
							variant="secondary"
							selectedKey={tab}
							onSelectionChange={(key) => navigate(`/${String(key)}`)}
							className="w-full max-w-md"
						>
							{/* The header's bottom border is the tab line: the container's
							    own border would add a second one, and -mb-px puts the
							    indicator on the line, not above it. */}
							<Tabs.ListContainer className="-mb-px border-b-0">
								{/* A tab is as wide as its own text (w-auto vs the w-full
								    default) — it does not split the page width four ways. */}
								<Tabs.List aria-label="Dashboard sections">
									{TABS.map((item) => (
										<Tabs.Tab key={item.id} id={item.id} className="h-12d">
											{item.label}
											<Tabs.Indicator />
										</Tabs.Tab>
									))}
								</Tabs.List>
							</Tabs.ListContainer>
						</Tabs>
					</nav>
				</div>
			</header>

			<main className="mx-auto max-w-[1400px] px-6 py-8">
				<Routes>
					<Route path="/" element={<Navigate to="/metrics" replace />} />
					<Route
						path="/metrics"
						element={
							run === undefined ? (
								<Empty />
							) : (
								<Metrics
									groups={groups}
									group={group}
									run={run}
									onExecution={selectExecution}
									onRun={setRunId}
								/>
							)
						}
					/>
					<Route
						path="/cases"
						element={run === undefined ? <Empty /> : <Cases run={run} />}
					/>
					<Route
						path="/stress"
						element={<Stress pluginId={plugin.id} severity={plugin.severity} />}
					/>
					<Route
						path="/history"
						element={
							<History pluginId={plugin.id} severity={plugin.severity} />
						}
					/>
					<Route path="*" element={<Navigate to="/metrics" replace />} />
				</Routes>
			</main>
		</div>
	)
}

function Empty() {
	return (
		<p className="py-16 text-center text-sm text-muted">
			This domain has no saved backtest runs.
		</p>
	)
}
