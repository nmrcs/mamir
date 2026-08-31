import type { DomainPluginInput } from '@mamir/contracts'

// Domain: mortgage credit risk, Freddie Mac Single-Family Loan-Level
// dataset. Domain explanation — docs/domain-credit-risk.md.
//
// The event here is not a loan application but a MONTHLY SERVICING RECORD:
// up to 360 of them per loan. The 2007 sample is 50,000 loans and 3,003,932
// events over the period 200612–202509.
//
// Field names correspond to positions in the dataset files (they have no
// headers, `|`-delimited); positions verified against the data, not the
// documentation.
export const creditRisk = {
	id: 'credit_risk',
	version: '0.1.0',

	event: {
		// --- from the origination file, fixed for the life of the loan
		LoanSequenceNumber: { type: 'string' },
		CreditScore: { type: 'number' },
		OriginalUPB: { type: 'number' },
		OriginalLTV: { type: 'number' },
		OriginalCLTV: { type: 'number' },
		OriginalDTI: { type: 'number' },
		OriginalInterestRate: { type: 'number' },
		OriginalLoanTerm: { type: 'number' },
		PropertyState: { type: 'string' },
		PropertyType: { type: 'string' },
		OccupancyStatus: { type: 'string' },
		LoanPurpose: { type: 'string' },
		Channel: { type: 'string' },
		NumberOfBorrowers: { type: 'string', required: false },
		FirstTimeHomebuyerFlag: { type: 'string' },

		// --- from monthly performance, change every month
		MonthlyReportingPeriod: { type: 'number' },
		CurrentActualUPB: { type: 'number' },
		CurrentLoanDelinquencyStatus: { type: 'string' },
		LoanAge: { type: 'number' },
		RemainingMonthsToLegalMaturity: { type: 'number', required: false },
		CurrentInterestRate: { type: 'number', required: false },
		ZeroBalanceCode: { type: 'string', required: false },
		EstimatedLTV: { type: 'number', required: false },
	},

	// The loan is the load-bearing entity: a long ordered history accumulates
	// on it. The state is a cohort axis; regional shock scenarios hit by it.
	entityKeys: {
		loan: 'LoanSequenceNumber',
		state: 'PropertyState',
	},

	// Domain granularity is the month. There is no day in the data at all.
	occurredAt: { path: 'MonthlyReportingPeriod', unit: 'yyyymm' },

	// Unpaid principal balance: unlike the card domain, exposure here
	// decreases over time for one and the same entity — the loan amortizes.
	// A stock: the position is the loan, exposure is the balance from its
	// latest record. Summing exposures over all events is wrong — one loan
	// has up to 360 of them.
	// severity — the fraction of the balance lost at default (LGD in the
	// industry). Measured on the raw servicing files: 14,126 removals with
	// codes 02/03/09 across the 1999–2007 cohorts, sum of Actual Loss
	// Calculation over sum of Zero Balance Removal UPB
	// = 1,021,010,552 / 2,176,783,154 = 0.469. Above zero and below one
	// because the house gets sold: the collateral covers part of the debt.
	//
	// A constant, although the value depends heavily on the regime: 1.4% for
	// year-2000 removals, 21% in 2005–2007, 41% in 2009, 51% in 2011, 61% in
	// 2016. A time-varying fraction would need its own point-in-time
	// treatment — on January 1, 2009 nobody knew the 2011 value, and
	// plugging it in would mean taking a number from the future. Here it is
	// the average over the whole period, i.e. a hindsight figure, and the
	// report says so.
	exposure: {
		path: 'CurrentActualUPB',
		position: 'entity',
		entity: 'loan',
		severity: 0.47,
	},

	// Default correlation. Measured on annual default rates by the method of
	// moments on a one-factor model: Φ⁻¹(DR_t) has variance ρ/(1−ρ), hence
	// ρ = V/(1+V). Script — scripts/correlation.py.
	//
	// The number here is the Basel IRB prescribed value for residential
	// mortgages, and that is a deliberate choice, not a borrowing. Our own
	// estimate over 26 annual observations is unstable: 0.028 on calm years,
	// 0.158 on backtest windows, 0.105 over the whole period, and a single
	// anomalous point moves it fivefold. Worse, the estimate is
	// systematically understated right before a crisis — standing in 2008 a
	// risk manager would have measured 0.028 and concluded the portfolio was
	// diversified. The prescribed value does not depend on whether a crisis
	// happened to be in the sample — that is the whole point of prescribing.
	correlation: 0.15,

	features: [
		// Delinquency dynamics per loan: how many months delinquent over a
		// year. Without where this would be a counter of reporting records —
		// roughly 12 for any live loan whether it pays or not.
		// Status 0 — pays on time; 'RA' never enters a numeric comparison.
		{
			name: 'loan_dlq_months_365d',
			entity: 'loan',
			agg: 'count',
			window: '365d',
			where: [{ field: 'CurrentLoanDelinquencyStatus', op: 'gte', value: 1 }],
		},
		// Time elapsed since the previous reporting record — gaps in
		// servicing are a signal in themselves.
		{
			name: 'loan_time_since_prev',
			entity: 'loan',
			agg: 'time_since',
			window: '365d',
		},
		// Balance trajectory: is the loan amortizing or standing still.
		{
			name: 'loan_upb_mean_365d',
			entity: 'loan',
			source: 'CurrentActualUPB',
			agg: 'mean',
			window: '365d',
		},
		{
			name: 'loan_upb_min_365d',
			entity: 'loan',
			source: 'CurrentActualUPB',
			agg: 'min',
			window: '365d',
		},
		// The loan's rate relative to itself a year ago — a restructuring
		// proxy.
		{
			name: 'loan_rate_mean_365d',
			entity: 'loan',
			source: 'CurrentInterestRate',
			agg: 'mean',
			window: '365d',
		},
		// Cohort features by state: the regional market's condition through
		// the portfolio's own eyes, no external macro series.
		{
			name: 'state_events_90d',
			entity: 'state',
			agg: 'count',
			window: '90d',
		},
		{
			name: 'state_upb_mean_365d',
			entity: 'state',
			source: 'CurrentActualUPB',
			agg: 'mean',
			window: '365d',
		},
		{
			name: 'state_eltv_mean_365d',
			entity: 'state',
			source: 'EstimatedLTV',
			agg: 'mean',
			window: '365d',
		},
	],

	// Loss: delinquency reaching 180 days, or foreclosure, or loan removal
	// with a credit-event code.
	//
	// Key point: the outcome is NOT recorded in the event itself — it
	// arrives in future records of the same loan, hence scope: 'forward'.
	// The 365-day horizon defines when the label became known.
	//
	// What is DELIBERATELY absent: code 01 (prepayment). It ends 85% of the
	// cohort's loans, and it is not a loss but a competing outcome. Labeling
	// "balance hit zero" would yield 92% positives instead of 13.7% and
	// learn the propensity to refinance.
	label: {
		scope: 'forward',
		entity: 'loan',
		horizon: '365d',
		anyOf: [
			// 6 = 180–209 days delinquent; statuses in the data run 0 to 156.
			[{ field: 'CurrentLoanDelinquencyStatus', op: 'gte', value: 6 }],
			// The collateral passed to the lender.
			[{ field: 'CurrentLoanDelinquencyStatus', op: 'eq', value: 'RA' }],
			// 02 — third-party sale, 03 — short sale or charge-off,
			// 09 — collateral disposition.
			[{ field: 'ZeroBalanceCode', op: 'in', value: ['02', '03', '09'] }],
		],
	},

	// What gets shocked is what is observed from outside — collateral value
	// and rate. Delinquency is deliberately untouched: its rise is what the
	// model must derive from the shock on its own. Setting it by hand means
	// inserting the answer into the problem statement and then measuring how
	// well it was inserted.
	scenarios: [
		{
			id: 'regional_shock',
			title: 'Regional market crash (California, Florida, Nevada)',
			select: [{ field: 'PropertyState', op: 'in', value: ['CA', 'FL', 'NV'] }],
			shock: [{ field: 'EstimatedLTV', op: 'mul', value: 1.4 }],
		},
		{
			id: 'high_ltv_rate_shock',
			title: 'Rate rise for the high-LTV-at-origination cohort',
			select: [{ field: 'OriginalLTV', op: 'gte', value: 90 }],
			shock: [{ field: 'CurrentInterestRate', op: 'add', value: 3 }],
		},
		{
			id: 'portfolio_wide',
			title: 'Broad macro shock: collateral cheapens, rates rise',
			select: [],
			shock: [
				{ field: 'EstimatedLTV', op: 'mul', value: 1.25 },
				{ field: 'CurrentInterestRate', op: 'add', value: 2 },
			],
		},
	],

	// Moments where comparing against reality says something. Both are taken
	// from the data itself, not from history at large: this cohort's loss
	// peak falls on 2009, the second spike on 2020.
	//
	// Dates are chosen so the label horizon covers the spike: the portfolio
	// as of January 1, labels mature by January 1 of the next year.
	history: [
		{
			id: 'crisis_2009',
			title: 'Crisis: the portfolio as of January 1, 2009',
			at: '2009-01-01T00:00:00.000Z',
		},
		{
			id: 'spike_2020',
			title: 'The 2020 spike: the portfolio as of January 1, 2020',
			at: '2020-01-01T00:00:00.000Z',
		},
	],
} satisfies DomainPluginInput

export default creditRisk
