import { Alert, Label, ListBox, Select, Spinner } from '@heroui/react'
import type { ReactNode } from 'react'
import type { Query } from './api'

// Query state in one place: all four screens share the same "loading",
// "failed" and "empty", and three of them would silently drift apart on the
// first edit.
export function Loaded<T>({
	query,
	empty,
	children,
}: {
	query: Query<T[]>
	empty: string
	children: (data: T[]) => ReactNode
}) {
	if (query.loading) {
		return (
			<div className="flex justify-center py-16">
				<Spinner />
			</div>
		)
	}
	if (query.error !== null) {
		return (
			<Alert status="danger">
				<Alert.Content>
					<Alert.Title>The core did not respond</Alert.Title>
					<Alert.Description>{query.error}</Alert.Description>
				</Alert.Content>
			</Alert>
		)
	}
	if (query.data === null || query.data.length === 0) {
		return <p className="py-16 text-center text-sm text-muted">{empty}</p>
	}
	return children(query.data)
}

export function Stat({
	label,
	value,
	hint,
}: {
	label: string
	value: ReactNode
	hint?: ReactNode
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-muted">{label}</span>
			<span className="text-lg font-medium tabular-nums">{value}</span>
			{hint !== undefined && (
				<span className="text-xs text-muted tabular-nums">{hint}</span>
			)}
		</div>
	)
}

export function Picker<T>({
	label,
	items,
	value,
	onChange,
	id,
	title,
}: {
	label: string
	items: T[]
	value: string
	onChange: (value: string) => void
	id: (item: T) => string
	title: (item: T) => string
}) {
	return (
		<Select
			className="w-full sm:w-[280px]"
			value={value}
			onChange={(next) => onChange(String(next))}
		>
			<Label>{label}</Label>
			<Select.Trigger>
				<Select.Value />
				<Select.Indicator />
			</Select.Trigger>
			<Select.Popover>
				<ListBox>
					{items.map((item) => (
						<ListBox.Item key={id(item)} id={id(item)} textValue={title(item)}>
							{title(item)}
							<ListBox.ItemIndicator />
						</ListBox.Item>
					))}
				</ListBox>
			</Select.Popover>
		</Select>
	)
}
