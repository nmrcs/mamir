// A bar with a rounded far end: at the base it sits flush on zero, otherwise
// the eye reads a floating rectangle as "does not start at zero".
export const bar = (x: number, y: number, w: number, h: number): string => {
	const r = Math.min(4, h, w / 2)
	return [
		`M ${x} ${y + h}`,
		`L ${x} ${y + r}`,
		`Q ${x} ${y} ${x + r} ${y}`,
		`L ${x + w - r} ${y}`,
		`Q ${x + w} ${y} ${x + w} ${y + r}`,
		`L ${x + w} ${y + h}`,
		'Z',
	].join(' ')
}
