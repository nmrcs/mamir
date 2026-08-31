#!/usr/bin/env node
// IEEE-CIS-shaped CSV generator: same columns, same sparsity.
// Exists to benchmark ingest and indexes without waiting for the licensed data
// (it is bound by competition rules and is not committed to the repo).
//
//   node scripts/synthetic-csv.mjs --rows 590000 --out data/synthetic.csv
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const rows = Number(args.get('rows') ?? 590000)
const out = args.get('out') ?? 'data/synthetic.csv'
const seed = Number(args.get('seed') ?? 42)

// Deterministic PRNG: runs are reproducible, numbers comparable across
// sessions. Math.random would make the measurements incomparable here.
// Math.imul, not `*`: 2^31 × 1103515245 exceeds 2^53, and plain multiplication
// loses precision in a double. The recurrence then stops being the declared
// LCG and degenerates — the period drops to 10,466 values. Over 590k rows ×
// 370 columns that is a repeating pattern with a ~28-row stride: a model
// memorizes the cycle and scores ROC-AUC 1.0 on a label that is by
// construction independent of every feature.
let state = seed
const rand = () => {
	state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
	return state / 0x7fffffff
}

const pick = (list) => list[Math.floor(rand() * list.length)]

const columns = [
	'TransactionID',
	'isFraud',
	'TransactionDT',
	'TransactionAmt',
	'ProductCD',
	...Array.from({ length: 6 }, (_, i) => `card${i + 1}`),
	'addr1',
	'addr2',
	'dist1',
	'dist2',
	'P_emaildomain',
	'R_emaildomain',
	...Array.from({ length: 14 }, (_, i) => `C${i + 1}`),
	...Array.from({ length: 15 }, (_, i) => `D${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `M${i + 1}`),
	...Array.from({ length: 339 }, (_, i) => `V${i + 1}`),
	// In the real dataset these two columns live in train_identity.csv and are
	// joined on TransactionID. Here they sit in the same file so the ingest
	// exercises all four aggregation axes.
	'DeviceType',
	'DeviceInfo',
]

const PRODUCTS = ['W', 'C', 'R', 'H', 'S']
const CARD4 = ['visa', 'mastercard', 'discover', 'american express']
const CARD6 = ['credit', 'debit']
const EMAILS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'anonymous.com', '']
const DEVICES = ['mobile', 'desktop', '']

await mkdir(dirname(out), { recursive: true })
const stream = createWriteStream(out)

const write = (line) =>
	stream.write(line)
		? Promise.resolve()
		: new Promise((r) => stream.once('drain', r))

await write(columns.join(',') + '\n')

// Six months in seconds, monotonic — like TransactionDT in the original.
const SPAN = 182 * 24 * 60 * 60
let dt = 86400

for (let i = 0; i < rows; i++) {
	dt += Math.max(1, Math.floor((SPAN / rows) * (0.5 + rand())))

	const row = new Array(columns.length)
	row[0] = 2987000 + i
	row[1] = rand() < 0.035 ? 1 : 0 // fraud rate as in IEEE-CIS
	row[2] = dt
	row[3] = (rand() * 500 + 5).toFixed(3)
	row[4] = pick(PRODUCTS)
	row[5] = 1000 + Math.floor(rand() * 17000) // card1
	row[6] = 100 + Math.floor(rand() * 500)
	row[7] = 150
	row[8] = pick(CARD4)
	row[9] = Math.floor(rand() * 300)
	row[10] = pick(CARD6)
	row[11] = rand() < 0.12 ? '' : 100 + Math.floor(rand() * 400) // addr1
	row[12] = rand() < 0.12 ? '' : 87
	row[13] = rand() < 0.6 ? '' : Math.floor(rand() * 200)
	row[14] = rand() < 0.94 ? '' : Math.floor(rand() * 200)
	row[15] = pick(EMAILS)
	row[16] = rand() < 0.77 ? '' : pick(EMAILS)

	// Sparsity as in the original: more than half of the cells are empty.
	for (let c = 17; c < columns.length - 2; c++) {
		row[c] = rand() < 0.55 ? '' : Math.floor(rand() * 100)
	}

	row[columns.length - 2] = pick(DEVICES)
	row[columns.length - 1] = rand() < 0.7 ? '' : 'SM-G930V Build/NRD90M'

	await write(row.join(',') + '\n')
}

await new Promise((resolve) => stream.end(resolve))
console.log(`✓ ${rows} rows × ${columns.length} columns → ${out}`)
