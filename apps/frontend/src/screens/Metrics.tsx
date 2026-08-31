import {
	Card,
	Chip,
	Table,
	ToggleButton,
	ToggleButtonGroup,
} from '@heroui/react'
import { useState } from 'react'
import type { BacktestRun } from '../api'
import { Deciles } from '../charts/Deciles'
import type { DriftPanel } from '../charts/Drift'
import { Drift } from '../charts/Drift'
import { Reliability } from '../charts/Reliability'
import { count, day, fixed, measured, money, percent } from '../format'
import type { Execution } from '../runs'
import { LEGACY } from '../runs'
import { Picker, Stat } from '../ui'

export function Metrics({
	groups,
	group,
	run,
	onExecution,
	onRun,
}: {
	groups: Execution[]
	group: Execution
	run: BacktestRun
	onExecution: (key: string) => void
	onRun: (id: string) => void
}) {
	const [panel, setPanel] = useState<DriftPanel>('ece')

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-end gap-4">
				<Picker
					label="Run"
					items={groups}
					value={group.key}
					onChange={onExecution}
					id={(item) => item.key}
					title={(item) => item.label}
				/>
				{group.key === LEGACY && (
					<Chip color="warning" variant="soft">
						executionId not recorded — windows may come from different runs
					</Chip>
				)}
			</div>

			<Card>
				<Card.Header className="flex-row flex-wrap items-start justify-between gap-4">
					<div className="flex flex-col">
						<Card.Title>Drift across windows</Card.Title>
						<Card.Description>
							Each point is one walk-forward window of the selected run. The
							calibration error grows across a regime break, and the moment the
							exposure-weighted ECE crosses above the per-event one, the error
							is moving onto the large positions — while ranking (ROC-AUC)
							barely moves. On the synthetic domain both error curves stay near
							zero and ROC-AUC sits on the random line — the correct answer
							there.
						</Card.Description>
					</div>
					{/* Not Tabs: a second Tabs on the page breaks the header nav's
					    variant (HeroUI v3 beta) — reproduced by clicking a tab. */}
					<ToggleButtonGroup
						aria-label="Drift metric"
						size="sm"
						disallowEmptySelection
						selectedKeys={[panel]}
						onSelectionChange={(keys) => setPanel([...keys][0] as DriftPanel)}
					>
						<ToggleButton id="ece">ECE</ToggleButton>
						<ToggleButton id="roc" className="whitespace-nowrap">
							<ToggleButtonGroup.Separator />
							ROC-AUC
						</ToggleButton>
					</ToggleButtonGroup>
				</Card.Header>
				<Card.Content>
					<Drift
						panel={panel}
						runs={group.runs}
						selected={run.id}
						onSelect={onRun}
					/>
				</Card.Content>
			</Card>

			<Card>
				<Card.Header>
					<Card.Title>Metrics by window</Card.Title>
					<Card.Description>
						Walk-forward: each window&apos;s model is trained only on what was
						known before the window began. Weighted Brier and ECE use the same
						events but weigh each by exposure at risk — a skew above one means
						the error grows where the money is.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<Table>
						<Table.ScrollContainer>
							<Table.Content
								aria-label="Backtest metrics by window"
								className="min-w-[900px]"
							>
								<Table.Header>
									<Table.Column isRowHeader>Window</Table.Column>
									<Table.Column>Trained to</Table.Column>
									<Table.Column>ROC-AUC</Table.Column>
									<Table.Column>PR-AUC</Table.Column>
									<Table.Column>Positives</Table.Column>
									<Table.Column>Brier</Table.Column>
									<Table.Column>Brier·wtd</Table.Column>
									<Table.Column>ECE</Table.Column>
									<Table.Column>ECE·wtd</Table.Column>
									<Table.Column>Skew</Table.Column>
									<Table.Column>Cases</Table.Column>
								</Table.Header>
								<Table.Body>
									{group.runs.map((item) => {
										const skew =
											item.metrics.eceWeighted === undefined
												? undefined
												: item.metrics.eceWeighted / item.metrics.ece
										return (
											<Table.Row
												key={item.id}
												id={item.id}
												className={
													item.id === run.id
														? 'cursor-pointer bg-accent-soft'
														: 'cursor-pointer'
												}
												onAction={() => onRun(item.id)}
											>
												<Table.Cell>
													{day(item.window.from)} → {day(item.window.to)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{day(item.model.trainWindowEnd)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{fixed(item.metrics.rocAuc, 3)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{fixed(item.metrics.prAuc, 3)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{percent(item.metrics.positiveRate)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{fixed(item.metrics.brier, 5)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{measured(item.metrics.brierWeighted, (value) =>
														fixed(value, 5),
													)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{fixed(item.metrics.ece, 5)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{measured(item.metrics.eceWeighted, (value) =>
														fixed(value, 5),
													)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{skew === undefined ? (
														'—'
													) : (
														<Chip
															size="sm"
															variant="soft"
															color={skew > 1 ? 'danger' : 'default'}
														>
															×{skew.toFixed(2)}
														</Chip>
													)}
												</Table.Cell>
												<Table.Cell className="tabular-nums">
													{item.cases}
												</Table.Cell>
											</Table.Row>
										)
									})}
								</Table.Body>
							</Table.Content>
						</Table.ScrollContainer>
					</Table>
				</Card.Content>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<Card.Header>
						<Card.Title>Calibration curve</Card.Title>
						<Card.Description>
							Window {day(run.window.from)} → {day(run.window.to)},{' '}
							{run.model.calibration} calibration. A point above the diagonal —
							the model underestimated risk; below — overestimated.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						<Reliability bins={run.reliability} />
					</Card.Content>
				</Card>

				<Card>
					<Card.Header>
						<Card.Title>Deciles by exposure at risk</Card.Title>
						<Card.Description>
							Groups equal in event count, ordered by exposure. No average
							metric ever shows this cut: averages weigh every event the same.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{run.deciles.length === 0 ? (
							<p className="py-16 text-center text-sm text-muted">
								This run predates the decile cut — there is nothing to compute
								it from retroactively.
							</p>
						) : (
							<Deciles deciles={run.deciles} />
						)}
					</Card.Content>
				</Card>
			</div>

			<Card>
				<Card.Header>
					<Card.Title>Decile figures</Card.Title>
				</Card.Header>
				<Card.Content>
					<Table>
						<Table.ScrollContainer>
							<Table.Content
								aria-label="Deciles of the selected window"
								className="min-w-[760px]"
							>
								<Table.Header>
									<Table.Column isRowHeader>Decile</Table.Column>
									<Table.Column>Exposure from</Table.Column>
									<Table.Column>to</Table.Column>
									<Table.Column>Events</Table.Column>
									<Table.Column>Predicted</Table.Column>
									<Table.Column>Observed</Table.Column>
									<Table.Column>Predicted loss</Table.Column>
									<Table.Column>Realized</Table.Column>
								</Table.Header>
								<Table.Body>
									{run.deciles.map((decile) => (
										<Table.Row key={decile.decile} id={decile.decile}>
											<Table.Cell>{decile.decile}</Table.Cell>
											<Table.Cell className="tabular-nums">
												{money(decile.from)}
											</Table.Cell>
											<Table.Cell className="tabular-nums">
												{money(decile.to)}
											</Table.Cell>
											<Table.Cell className="tabular-nums">
												{count(decile.count)}
											</Table.Cell>
											<Table.Cell className="tabular-nums">
												{percent(decile.predicted, 3)}
											</Table.Cell>
											<Table.Cell className="tabular-nums">
												{percent(decile.observed, 3)}
											</Table.Cell>
											<Table.Cell className="tabular-nums">
												{money(decile.predictedLoss)}
											</Table.Cell>
											<Table.Cell className="tabular-nums">
												{money(decile.realizedLoss)}
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table.Content>
						</Table.ScrollContainer>
					</Table>
				</Card.Content>
				<Card.Footer className="flex flex-wrap gap-8">
					<Stat label="Model version" value={run.model.id} />
					<Stat label="Log-loss" value={fixed(run.metrics.logLoss, 5)} />
					<Stat label="Run recorded" value={day(run.createdAt)} />
				</Card.Footer>
			</Card>
		</div>
	)
}
