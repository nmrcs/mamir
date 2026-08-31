// Scale top and tick labels. Rounds up to 1/2/5×10ⁿ — otherwise the axis is
// labeled with numbers like 0.0473, and two charts cannot be compared by eye.
export function niceScale(
	max: number,
	steps = 4,
): { max: number; ticks: number[] } {
	if (max <= 0) return { max: 1, ticks: [0, 1] }

	const rough = max / steps
	const magnitude = 10 ** Math.floor(Math.log10(rough))
	const normalized = rough / magnitude
	const step =
		(normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) *
		magnitude

	const top = Math.ceil(max / step) * step
	const ticks: number[] = []
	for (let value = 0; value <= top + step / 2; value += step) ticks.push(value)

	return { max: top, ticks }
}
