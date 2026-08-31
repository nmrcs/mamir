import { Card, Chip, Table } from '@heroui/react'
import { useState } from 'react'
import type { ScenarioRun, ScenarioSpec } from '../api'
import { useApi } from '../api'
import { count, day, money, percent } from '../format'
import { Loaded, Stat } from '../ui'

export function Stress({
	pluginId,
	severity,
}: {
	pluginId: string
	severity: number
}) {
	const runs = useApi<ScenarioRun[]>(`/scenarios/runs?plugin=${pluginId}`)
	const specs = useApi<ScenarioSpec[]>('/scenarios')
	const [selected, setSelected] = useState<string | null>(null)

	return (
		<Loaded query={runs} empty="No scenario has been run on this domain yet.">
			{(list) => {
				const run = list.find((item) => item.id === selected) ?? list[0]
				const spec = specs.data?.find(
					(item) =>
						item.pluginId === run.pluginId && item.id === run.scenarioId,
				)
				const shocked = Object.entries(run.coverage.shocked)
				const touched = shocked.reduce((sum, [, value]) => sum + value, 0)

				return (
					<div className="flex flex-col gap-6">
						<Card>
							<Card.Header>
								<Card.Title>Scenario runs</Card.Title>
								<Card.Description>
									Saved runs, not a recompute on page load: assembling the
									portfolio on a balance-sheet domain takes minutes. Amounts are
									expected losses: probability × loss share{' '}
									{percent(severity, 0)} × exposure at risk.
								</Card.Description>
							</Card.Header>
							<Card.Content>
								<Table>
									<Table.ScrollContainer>
										<Table.Content
											aria-label="Saved scenario runs"
											className="min-w-[860px]"
										>
											<Table.Header>
												<Table.Column isRowHeader>Scenario</Table.Column>
												<Table.Column>As of</Table.Column>
												<Table.Column>Lookback</Table.Column>
												<Table.Column>Positions</Table.Column>
												<Table.Column>Exposure</Table.Column>
												<Table.Column>EL before</Table.Column>
												<Table.Column>EL after</Table.Column>
												<Table.Column>ΔEL</Table.Column>
												<Table.Column>Affected</Table.Column>
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
															{item.lookback}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{count(item.positions)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{money(item.exposure)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{money(item.baseEL)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{money(item.stressedEL)}
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															<Chip
																size="sm"
																variant="soft"
																color={item.deltaEL > 0 ? 'danger' : 'default'}
															>
																{percent(item.deltaEL / item.baseEL, 1)}
															</Chip>
														</Table.Cell>
														<Table.Cell className="tabular-nums">
															{count(item.affected)}
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
										Coverage separates “selected, but nothing to change” from
										“changed”: without it a zero ΔEL and a resilient portfolio
										look identical.
									</Card.Description>
								</Card.Header>
								<Card.Content className="flex flex-col gap-5">
									<div className="flex flex-wrap gap-8">
										<Stat label="Scanned" value={count(run.coverage.scanned)} />
										<Stat
											label="Selected"
											value={count(run.coverage.selected)}
										/>
										<Stat label="Changed" value={count(touched)} />
									</div>

									{touched === 0 && (
										<Chip color="warning" variant="soft">
											The shock reached zero rows — the field is absent from
											this window&apos;s events
										</Chip>
									)}

									{spec !== undefined && (
										<div className="flex flex-col gap-2">
											<span className="text-xs text-muted">
												What is shocked
											</span>
											<div className="flex flex-wrap gap-2">
												{spec.shock.map((change) => (
													<Chip key={change.field} size="sm">
														{change.field} {change.op} {String(change.value)}
													</Chip>
												))}
											</div>
										</div>
									)}

									<div className="flex flex-col gap-2">
										<span className="text-xs text-muted">
											Features the shock can reach per the declaration
										</span>
										<div className="flex flex-wrap gap-2">
											{run.recomputed.map((feature) => (
												<Chip key={feature} size="sm" variant="soft">
													{feature}
												</Chip>
											))}
										</div>
									</div>
								</Card.Content>
								<Card.Footer>
									<Stat label="Model version" value={run.modelVersion} />
								</Card.Footer>
							</Card>

							<Card>
								<Card.Header>
									<Card.Title>Extrapolation</Card.Title>
									<Card.Description>
										Share of values beyond the 99th percentile of the training
										set. The model never saw such values, so its answer there is
										unknown — not merely “higher”.
									</Card.Description>
								</Card.Header>
								<Card.Content>
									<Table>
										<Table.ScrollContainer>
											<Table.Content aria-label="Extrapolation share by feature">
												<Table.Header>
													<Table.Column isRowHeader>Feature</Table.Column>
													<Table.Column>Training p99</Table.Column>
													<Table.Column>Before shock</Table.Column>
													<Table.Column>After</Table.Column>
												</Table.Header>
												<Table.Body>
													{Object.entries(run.extrapolation).map(
														([feature, value]) => (
															<Table.Row key={feature} id={feature}>
																<Table.Cell>{feature}</Table.Cell>
																<Table.Cell className="tabular-nums">
																	{value.p99 === null
																		? '—'
																		: value.p99.toLocaleString('en-US')}
																</Table.Cell>
																<Table.Cell className="tabular-nums">
																	{percent(value.base, 3)}
																</Table.Cell>
																<Table.Cell className="tabular-nums">
																	{percent(value.stressed, 3)}
																</Table.Cell>
															</Table.Row>
														),
													)}
												</Table.Body>
											</Table.Content>
										</Table.ScrollContainer>
									</Table>
								</Card.Content>
							</Card>
						</div>
					</div>
				)
			}}
		</Loaded>
	)
}
