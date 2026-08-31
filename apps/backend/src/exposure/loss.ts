// Expected loss — one definition for the whole project.
//
// The formula lived in five places: the portfolio, both sides of a
// scenario's ΔEL, both sides of the historical run. While there were two
// factors, the copies agreed; when the third appeared — the loss share —
// it had to be added to every copy by hand, and no test would have noticed
// it missing in one of them. Same technique as with features: one
// definition, not five identical lines.
export const expectedLoss = (
	probability: number,
	severity: number,
	exposure: number,
): number => probability * severity * exposure

// Realized loss: the outcome is already known, there is no probability. The
// loss share enters here too — otherwise the sides of the comparison
// measure different things, and the gap between predicted and realized
// stops being a ratio of like quantities.
export const realizedLoss = (
	happened: boolean,
	severity: number,
	exposure: number,
): number => (happened ? severity * exposure : 0)
