import { Card, Chip, Table } from '@heroui/react'
import { useState } from 'react'
import type { HistoryRun, HistorySpec } from '../api'
import { useApi } from '../api'
import { Deciles } from '../charts/Deciles'
import { Gap } from '../charts/Gap'
import { DistributionSection } from '../charts/Distribution'
import { count, day, money, percent, ratio } from '../format'
import { Loaded, Stat } from '../ui'

export function History({
	pluginId,
	severity,
}: {
	pluginId: string
	severity: number
}) {
	const runs = useApi<HistoryRun[]>(`/history/runs?plugin=${pluginId}`)
	const specs = useApi<HistorySpec[]>('/history')
	const [selected, setSelected] = useState<string | null>(null)

	return (
		<Loaded
			query={runs}
			empty="No historical episode has been run on this domain."
		>
			{(list) => {
				const run = list.find((item) => item.id === selected) ?? list[0]
				const spec = specs.data?.find(
					(item) =>
						item.pluginId === run.pluginId && item.id === run.scenarioId,
				)
				const dropped = run.positions - run.compared

				return (
					<div className="flex flex-col gap-6">
						<Card>
							<Card.Header>
								<Card.Title>Checked against history</Card.Title>
								<Card.Description>
									What the model said as of t — and how it actually ended. The
									moment comes from the domain declaration, not the request: it
									is a named episode, not a knob for picking a flattering date.
									Both sides are multiplied by the domain&apos;s loss share —{' '}
									{percent(severity, 0)}.
								</Card.Description>
							</Card.Header>
							<Card.Content>
								<Table>
									<Table.ScrollContainer>
										<Table.Content
											aria-label="Saved historical runs"
											className="min-w-[1050px]"
										>
											<Table.Header>
												<Table.Column isRowHeader>Episode</Table.Column>
												<Table.Column>As of</Table.Column>
												<Table.Column>Model trained to</Table.Column>
												<Table.Column>Positions</Table.Column>
												<Table.Column>Compared</Table.Column>
												<Table.Column>Predicted</Table.Column>
												<Table.Column>Realized</Table.Column>
												<Table.Column>Gap</Table.Column>
												<Table.Column>ρ</Table.Column>
												<Table.Column>Tail percentile</Table.Column>
											</Table.Header>
											<Table.Body>
												{list.map((item) => (
													<Table.Row
														key={item.id}
														id={item.id}
														className={
															item.id === run.id
																? 'cursor-pointer bg-accent-soft'
																: 'cursor-pointer'
														}
														onAction={() => setSelected(item.id)}
													>
														<Table.Cell>{item.scenarioId}</Table.Cell>
														<Table.Cell className="tabular-nums">
															{day(item.at)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{day(item.trainedTo)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{count(item.positions)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{count(item.compared)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{money(item.predictedEL)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{money(item.realizedLoss)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															<Chip
																size="sm"
																variant="soft"
																color={item.ratio > 1 ? 'danger' : 'default'}
															>
																{ratio(item.ratio)}
															</Chip>
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{item.distribution === null
																? '—'
																: item.distribution.rho}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{item.distribution?.realized == null
																? '—'
																: percent(
																		item.distribution.realized.percentile,
																		1,
																	)}
														</Table.Cell>
													</Table.Row>
												))}
											</Table.Body>
										</Table.Content>
									</Table.ScrollContainer>
								</Table>
							</Card.Content>
						</Card>

						<div className="grid gap-6 lg:grid-cols-2">
							<Card>
								<Card.Header>
									<Card.Title>{spec?.title ?? run.scenarioId}</Card.Title>
									<Card.Description>
										Only positions with both sides are compared: a feature
										vector and a matured label. An unmatured label reads “did
										not occur”, and silently including it would understate the
										realized loss.
									</Card.Description>
								</Card.Header>
								<Card.Content className="flex flex-col gap-6">
									<div className="flex flex-wrap gap-8">
										<Stat
											label="Predicted loss"
											value={money(run.predictedEL)}
											hint={`${run.expectedPositives.toFixed(0)} events expected`}
										/>
										<Stat
											label="Realized loss"
											value={money(run.realizedLoss)}
											hint={`${count(run.observedPositives)} events occurred`}
										/>
										<Stat
											label="Gap in money"
											value={ratio(run.ratio)}
											hint={`in counts ${ratio(run.observedPositives / run.expectedPositives)}`}
										/>
									</div>

									<Gap run={run} />

									<div>
										<span className="text-xs text-muted">
											Dropped from comparison: {count(dropped)} of{' '}
											{count(run.positions)} positions
										</span>
										<Table className="mt-2">
											<Table.ScrollContainer>
												<Table.Content aria-label="Why positions were dropped">
													<Table.Header>
														<Table.Column isRowHeader>Reason</Table.Column>
														<Table.Column>Positions</Table.Column>
													</Table.Header>
													<Table.Body>
														<Table.Row id="vector">
															<Table.Cell>No feature vector</Table.Cell>
															<Table.Cell className="tabular-nums">
																{count(run.withoutVector)}
															</Table.Cell>
														</Table.Row>
														<Table.Row id="label">
															<Table.Cell>No label</Table.Cell>
															<Table.Cell className="tabular-nums">
																{count(run.withoutLabel)}
															</Table.Cell>
														</Table.Row>
														<Table.Row id="unmatured">
															<Table.Cell>Label not matured</Table.Cell>
															<Table.Cell className="tabular-nums">
																{count(run.unmatured)}
															</Table.Cell>
														</Table.Row>
													</Table.Body>
												</Table.Content>
											</Table.ScrollContainer>
										</Table>
									</div>
								</Card.Content>
								<Card.Footer className="flex flex-wrap gap-8">
									<Stat label="Model version" value={run.modelVersion} />
									<Stat label="Position lookback" value={run.lookback} />
									<Stat
										label="Portfolio exposure"
										value={money(run.exposure)}
									/>
								</Card.Footer>
							</Card>

							<Card>
								<Card.Header>
									<Card.Title>Gap by decile</Card.Title>
									<Card.Description>
										The realized-to-predicted ratio says how many times the
										model was off, but not where.
									</Card.Description>
								</Card.Header>
								<Card.Content className="flex flex-col gap-4">
									<Deciles deciles={run.deciles} />
									<Table>
										<Table.ScrollContainer>
											<Table.Content
												aria-label="Deciles of the historical run"
												className="min-w-[560px]"
											>
												<Table.Header>
													<Table.Column isRowHeader>Decile</Table.Column>
													<Table.Column>Positions</Table.Column>
													<Table.Column>Predicted</Table.Column>
													<Table.Column>Realized</Table.Column>
													<Table.Column>Gap</Table.Column>
												</Table.Header>
												<Table.Body>
													{run.deciles.map((decile) => (
														<Table.Row key={decile.decile} id={decile.decile}>
															<Table.Cell>
																{decile.decile} · {money(decile.from)}—
																{money(decile.to)}
															</Table.Cell>
															<Table.Cell className="tabular-nums">
																{count(decile.count)}
															</Table.Cell>
															<Table.Cell className="tabular-nums">
																{money(decile.predictedLoss)}
															</Table.Cell>
															<Table.Cell className="tabular-nums">
																{money(decile.realizedLoss)}
															</Table.Cell>
															<Table.Cell className="tabular-nums">
																{decile.predictedLoss === 0
																	? '—'
																	: ratio(
																			decile.realizedLoss /
																				decile.predictedLoss,
																		)}
															</Table.Cell>
														</Table.Row>
													))}
												</Table.Body>
											</Table.Content>
										</Table.ScrollContainer>
									</Table>
								</Card.Content>
							</Card>
						</div>

						<Card>
							<Card.Header>
								<Card.Title>Loss distribution</Card.Title>
								<Card.Description>
									Answers “if the probabilities are right, how bad can it get” —
									and where in that tail the fact landed. Whether they are right
									is the backtest&apos;s question, and mixing the two is
									forbidden: a model&apos;s miss declared a tail outcome is an
									error passed off as bad luck. The correlation ρ is declared by
									the domain; runs with a different ρ in the table above are the
									sensitivity band of the system&apos;s least reliable
									parameter.
								</Card.Description>
							</Card.Header>
							<Card.Content>
								<DistributionSection distribution={run.distribution} />
							</Card.Content>
						</Card>
					</div>
				)
			}}
		</Loaded>
	)
}
