// The date is sliced from the ISO string, not parsed into a Date: `new
// Date(...)` would show the instant in the machine's zone, and a "January 1"
// portfolio would be labeled December 31 in the US Eastern zone. The project
// already got burned by this in SQL.
export const day = (iso: string): string => iso.slice(0, 10)

const EN = new Intl.NumberFormat('en-US')

export const count = (value: number): string => EN.format(Math.round(value))

// Money in orders of magnitude, not in cents: exposure at 29.8B and EL at
// 343M differ in magnitude, and the full number is unreadable side by side.
export const money = (value: number): string => {
	const abs = Math.abs(value)
	if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
	if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`
	if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`
	return value.toFixed(0)
}

export const percent = (share: number, digits = 2): string =>
	`${(share * 100).toFixed(digits)}%`

export const fixed = (value: number, digits = 4): string =>
	value.toFixed(digits)

// A dash means "not measured", not "zero": runs made before weighted metrics
// existed lack these keys entirely.
export const measured = (
	value: number | undefined,
	render: (value: number) => string,
): string => (value === undefined ? '—' : render(value))

export const ratio = (value: number): string => `×${value.toFixed(2)}`
