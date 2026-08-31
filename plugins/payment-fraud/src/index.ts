import type { DomainPluginInput } from '@mamir/contracts'

// Domain: card transaction fraud, IEEE-CIS dataset.
//
// `event` declares only the fields the platform needs: aggregation axis,
// timestamp, exposure, label, and feature sources. The dataset has 430+
// (C1..C14, D1..D15, M1..M9, V1..V339); declaring them all by hand is
// pointless — the rest arrives in the payload as is and is stored, but the
// platform does not use it.
//
// Time reference: TransactionDT is seconds from an unknown moment, not a
// date. Point-in-time only needs monotonicity, so all windows are computed
// in relative time.
export const paymentFraud = {
	id: 'payment_fraud',
	version: '0.1.0',

	event: {
		TransactionID: { type: 'string' },
		TransactionDT: { type: 'number' },
		TransactionAmt: { type: 'number' },
		ProductCD: { type: 'string' },
		card1: { type: 'string' },
		card4: { type: 'string', required: false },
		card6: { type: 'string', required: false },
		addr1: { type: 'string', required: false },
		P_emaildomain: { type: 'string', required: false },
		DeviceType: { type: 'string', required: false },
		DeviceInfo: { type: 'string', required: false },
		isFraud: { type: 'number' },
	},

	entityKeys: {
		card: 'card1',
		addr: 'addr1',
		email: 'P_emaildomain',
		device: 'DeviceInfo',
	},

	occurredAt: { path: 'TransactionDT', unit: 'seconds' },
	// A flow: the position is the transaction itself. It is instantaneous;
	// "the card's latest amount" is not an exposure, while a sum over a
	// window is. severity 1 — there is no collateral here, nothing to
	// recover with: a fraudulent transaction is lost in full. In a real
	// payment domain a chargeback would return part of it, but the data is
	// synthetic and contains no recoveries by construction.
	exposure: { path: 'TransactionAmt', position: 'event', severity: 1 },

	// Zero — and this is measurable, not an assumption: the synthetic label
	// is generated from a hash of the transaction id, independent of
	// anything else. There is no common factor by construction, and the
	// portfolio must add up as a sum of independent events. It also gives a
	// degenerate case for checking the simulation: at ρ = 0 it reduces to a
	// binomial sum.
	//
	// In a real payment domain zero would be wrong: a coordinated attack is
	// exactly a common factor.
	correlation: 0,

	// The outcome is recorded in the event itself — a transaction is either
	// fraud or not. IEEE-CIS labeling is final; there is no confirmation
	// moment in the data: 30 days is an assumption from chargeback practice,
	// stated out loud in the README and the backtest reports, not hidden.
	label: {
		scope: 'self',
		horizon: '30d',
		anyOf: [[{ field: 'isFraud', op: 'eq', value: 1 }]],
	},

	features: [
		// Card velocity — the baseline signal: a burst of attempts in a
		// short window.
		{ name: 'card_txn_count_24h', entity: 'card', agg: 'count', window: '24h' },
		{
			name: 'card_amt_sum_24h',
			entity: 'card',
			source: 'TransactionAmt',
			agg: 'sum',
			window: '24h',
		},
		// Amount deviation from what is usual for this card.
		{
			name: 'card_amt_mean_7d',
			entity: 'card',
			source: 'TransactionAmt',
			agg: 'mean',
			window: '7d',
		},
		{
			name: 'card_amt_std_7d',
			entity: 'card',
			source: 'TransactionAmt',
			agg: 'std',
			window: '7d',
		},
		// Pause before the transaction: a rapid series looks different from
		// a one-off.
		{
			name: 'card_time_since_prev',
			entity: 'card',
			agg: 'time_since',
			window: '30d',
		},
		// A card wandering across addresses — a classic signal.
		{
			name: 'card_distinct_addr_7d',
			entity: 'card',
			source: 'addr1',
			agg: 'distinct',
			window: '7d',
		},
		{ name: 'addr_txn_count_7d', entity: 'addr', agg: 'count', window: '7d' },
		{ name: 'email_txn_count_7d', entity: 'email', agg: 'count', window: '7d' },
		{
			name: 'device_txn_count_24h',
			entity: 'device',
			agg: 'count',
			window: '24h',
		},
	],

	// About attack volume a field shock truly can say nothing: "8x more
	// transactions" means generating events, while a shock changes values in
	// existing ones. But not every attack is about volume — a card takeover
	// looks like a sharp rise in amounts at the same frequency, and that is
	// exactly a field shock.
	//
	// The domain difference surfaces right here: `TransactionAmt` is both a
	// feature source and the exposure field, so the shock moves both sides
	// of ΔEL. Mortgages never have this: rate and LTV get shocked, while the
	// outstanding balance is what is at risk.
	scenarios: [
		{
			id: 'amount_spike',
			title: 'Card takeover: amounts tripled at the same frequency',
			select: [],
			shock: [{ field: 'TransactionAmt', op: 'mul', value: 3 }],
		},
		{
			id: 'card_present_spike',
			title: 'Amount spike in a single product type',
			select: [{ field: 'ProductCD', op: 'eq', value: 'W' }],
			shock: [{ field: 'TransactionAmt', op: 'mul', value: 5 }],
		},
	],

	// The single episode is a control, and that is its entire point. The
	// synthetic label is independent of the features, so the historical run
	// here has a known correct answer: realized losses must land in the body
	// of the distribution at ρ = 0, not in the tail. The credit domain
	// checks that the portfolio layer sees a crisis; this one — that it does
	// not invent a crisis where there is none. The date is on the relative
	// TransactionDT scale, like all of the domain's time: the last month
	// whose labels manage to mature before the data ends.
	history: [
		{
			id: 'control_month',
			title: 'Control month: the portfolio as of 1970-06-01, relative scale',
			at: '1970-06-01T00:00:00.000Z',
		},
	],
} satisfies DomainPluginInput

export default paymentFraud
