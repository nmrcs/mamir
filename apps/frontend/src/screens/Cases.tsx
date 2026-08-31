import { Card, Chip, Table } from '@heroui/react'
import type { BacktestRun, Case } from '../api'
import { useApi } from '../api'
import { day, money, percent } from '../format'
import { Loaded } from '../ui'

// A miss is shown on par with a catch — a project rule, not styling: a report
// that shows only catches is marketing.
const KIND: Record<string, { title: string; color: 'success' | 'danger' }> = {
	CAUGHT: { title: 'Caught', color: 'success' },
	MISSED: { title: 'Miss', color: 'danger' },
	FALSE_POSITIVE: { title: 'False alarm', color: 'danger' },
}

function Vector({ values }: { values: Record<string, number | null> | null }) {
	if (values === null) {
		return (
			<p className="text-sm text-muted">
				No vector: the event exists, features were never materialized.
			</p>
		)
	}

	return (
		<Table>
			<Table.ScrollContainer>
				<Table.Content aria-label="Feature vector as of the event">
					<Table.Header>
						<Table.Column isRowHeader>Feature</Table.Column>
						<Table.Column>Value as of the event</Table.Column>
					</Table.Header>
					<Table.Body>
						{Object.entries(values).map(([name, value]) => (
							<Table.Row key={name} id={name}>
								<Table.Cell>{name}</Table.Cell>
								<Table.Cell className="tabular-nums">
									{value === null ? '—' : value.toLocaleString('en-US')}
								</Table.Cell>
							</Table.Row>
						))}
					</Table.Body>
				</Table.Content>
			</Table.ScrollContainer>
		</Table>
	)
}

export function Cases({ run }: { run: BacktestRun }) {
	const query = useApi<Case[]>(`/backtests/${run.id}/cases`)

	return (
		<Loaded query={query} empty="No cases recorded for this window.">
			{(cases) => (
				<div className="flex flex-col gap-6">
					{/* The window and model version are named here, not implied:
					    without them a probability is a number, not a claim. */}
					<p className="text-sm text-muted">
						Window {day(run.window.from)} → {day(run.window.to)}, model{' '}
						{run.model.id} trained to {day(run.model.trainWindowEnd)}. Cases
						were picked by this window&apos;s run and belong to it alone.
					</p>
					<div className="grid gap-6 lg:grid-cols-2">
						{cases.map((item) => {
							const kind = KIND[item.kind]
							return (
								<Card key={item.eventId}>
									<Card.Header>
										<div className="flex flex-wrap items-center gap-3">
											<Chip color={kind.color} variant="soft">
												{kind.title}
											</Chip>
											<Card.Title>{item.name}</Card.Title>
										</div>
										<Card.Description>
											{day(item.occurredAt)} · exposure at risk{' '}
											{money(Number(item.exposure))} · the model said{' '}
											{percent(item.probability, 2)}
										</Card.Description>
									</Card.Header>
									<Card.Content className="flex flex-col gap-4">
										<div className="flex flex-wrap gap-2">
											{Object.entries(item.entityKeys).map(([axis, value]) => (
												<Chip key={axis} size="sm">
													{axis}: {value}
												</Chip>
											))}
										</div>
										<p className="text-sm">
											{item.outcome === null
												? 'Outcome unknown: the event has no label.'
												: item.outcome.value
													? `The event occurred; the label matured ${day(item.outcome.resolvedAt)}.`
													: `The event did not occur; the label matured ${day(item.outcome.resolvedAt)}.`}
										</p>
										<Vector values={item.values} />
									</Card.Content>
								</Card>
							)
						})}
					</div>
				</div>
			)}
		</Loaded>
	)
}
