import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Client } from 'pg'
import { to as copyTo } from 'pg-copy-streams'
import type { Env } from '../config/env'
import { PluginRegistryService } from '../plugins/plugin-registry.service'

export interface ExportOptions {
	pluginId: string
	// Lower bound of the window. Without it the whole history up to `until` is
	// exported — a training set; with it — a window, i.e. the test slice of a
	// backtest.
	from?: Date
	// Moment the dataset is assembled as of. Required: a training set without
	// a time bound is not a sample but the whole history, and a model trained
	// on it is not reproducible.
	until: Date
	// Moment by which the label must have matured — and it is NOT derived from
	// `until`. These are two different questions, and answering both with one
	// bound cuts the test window down to its first month:
	//
	//   training — "what was KNOWN as of t": the label must mature by t
	//     itself, or the model learns from labels taken from the future;
	//   evaluation — "how it ultimately ENDED": the report is written today
	//     and knows the outcome, while the model never saw the test window
	//     anyway.
	//
	// Hence 'history-end': matured within the available history.
	maturedBy: Date | 'history-end'
	out: string
}

export interface ExportReport {
	rows: number
	path: string
	bytes: number
	elapsedMs: number
	// Maturation bound actually applied. Differs from `until` when history is
	// shorter than the requested moment — see maturityCutoff.
	maturedUntil: string
}

// Exports the training set as a file. The scoring service never touches the
// DB and knows nothing of the core schema: it gets a path and reads ready
// numbers — exactly the ones that would go to prod, because they live in
// FeatureVector, put there by the same window compiler.
//
// A file, not an HTTP request body: training up to 2008 is millions of rows.
// As a side effect the dataset becomes an artifact: it can be stored next to
// a ModelVersion and the run repeated a month later.
@Injectable()
export class DatasetService {
	private readonly logger = new Logger(DatasetService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly config: ConfigService<Env, true>,
	) {}

	async export(options: ExportOptions): Promise<ExportReport> {
		const plugin = this.registry.get(options.pluginId)
		const startedAt = Date.now()
		const until = options.until.toISOString()

		const columns = plugin.features
			.map((f) => `(v.values->>'${f.name}')::float8 AS "${f.name}"`)
			.join(',\n           ')

		const client = new Client({
			connectionString: this.config.get('DATABASE_URL', { infer: true }),
		})
		await client.connect()

		const maturedUntil = await this.maturityCutoff(
			client,
			plugin.id,
			options.maturedBy,
		)
		const lower = options.from
			? `\n          AND e."ingestedAt" >= TIMESTAMP '${options.from.toISOString()}'`
			: ''

		// Three time filters, and all three are mandatory:
		//   ingestedAt >= from  — the backtest window, if given;
		//   ingestedAt <  until — the event was KNOWN by `until`;
		//   resolvedAt <= maturedUntil — the label had time to MATURE, and did
		//                                so within the available history.
		const query = `
      COPY (
        SELECT e.id AS "eventId",
               e."occurredAt" AS at,
               -- ::int, not boolean: in CSV a boolean turns into t/f and the
               -- reading side would have to guess them. A format that has no
               -- booleans is no reason to parse them out of strings.
               l.value::int AS label,
               -- The amount at risk rides next to the label, not among the
               -- features. Per-event metrics weight all rows equally, so a
               -- 50k loan enters them the same as a 700 one; without this
               -- column there is nothing to compute the weighted variant
               -- from. It does not become a feature: service columns are
               -- listed explicitly, everything else scoring treats as a
               -- feature.
               e.exposure::float8 AS exposure,
               ${columns}
        FROM "Event" e
        JOIN "FeatureVector" v ON v."eventId" = e.id
        JOIN "Label" l ON l."eventId" = e.id
        WHERE e."pluginId" = '${plugin.id}'${lower}
          AND e."ingestedAt" < TIMESTAMP '${until}'
          AND l."resolvedAt" <= TIMESTAMP '${maturedUntil}'
        -- The ordering must be total, or the export is not reproducible.
        -- Sorting by occurredAt is not enough: the domain's grain is a
        -- month, so within a reporting period millions of rows tie and
        -- line up arbitrarily. Downstream this decides which rows land in
        -- the calibration share: it is cut by POSITION (frame.iloc), and
        -- the boundary passes inside a group with the same date. The same
        -- arbitrary order that is banned in feature windows — only here it
        -- was slipping in through the export.
        ORDER BY e."occurredAt", e.id
      ) TO STDOUT WITH (FORMAT csv, HEADER)
    `

		let rows = -1 // header
		const count = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				for (const byte of chunk) {
					if (byte === 0x0a) rows++
				}
				done(null, chunk)
			},
		})

		try {
			await pipeline(
				client.query(copyTo(query)),
				count,
				createWriteStream(options.out),
			)
		} finally {
			await client.end()
		}

		const report: ExportReport = {
			rows,
			maturedUntil,
			path: options.out,
			bytes: (await stat(options.out)).size,
			elapsedMs: Date.now() - startedAt,
		}

		this.logger.log({
			actionCode: 'dataset.service.export.completed',
			pluginId: plugin.id,
			from: options.from?.toISOString(),
			until,
			maturedBy:
				options.maturedBy === 'history-end'
					? 'history-end'
					: options.maturedBy.toISOString(),
			features: plugin.features.length,
			...report,
		})

		return report
	}

	// A label matures over a forward window, and history is finite. For
	// events of the last horizon the window hits the edge of the data and
	// returns "no loss" — not because there was none, but because there was
	// nowhere to look. Such a label is biased toward the negative and must
	// not enter the dataset.
	//
	// On Freddie Mac that is 81,902 events: history ends at 2025-09, labels
	// reach out to 2026-09.
	//
	// The edge of history is the ceiling in both modes: nothing beyond it
	// has matured, no matter how much is requested.
	private async maturityCutoff(
		client: Client,
		pluginId: string,
		maturedBy: Date | 'history-end',
	): Promise<string> {
		// to_char, not Date. The column is declared `timestamp without time
		// zone`, the driver reads it as LOCAL time, and toISOString() shifts
		// the bound by the machine's offset. It goes back into SQL as a
		// string, where the shift is never undone: as a Date parameter the
		// round trip is symmetric, as a string it is not.
		//
		// The error's direction depended on the developer's time zone: east
		// of UTC the bound drifted backward and lost matured labels, west of
		// UTC — forward, admitting labels computed on a truncated future.
		// That is, on a machine in the US this was leakage, and on a machine
		// in Moscow — a silent loss of data.
		const { rows } = await client.query<{ max: string | null }>(
			`SELECT to_char(max("ingestedAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS max
			 FROM "Event" WHERE "pluginId" = $1`,
			[pluginId],
		)
		const dataEnd = rows[0]?.max
		if (maturedBy === 'history-end') {
			if (!dataEnd) throw new Error(`plugin ${pluginId} has no events`)
			return dataEnd
		}

		// The caller's moment is UTC by construction, and the system treats
		// timestamps in the DB as UTC. The zone suffix is stripped so both
		// values are compared in the same representation.
		const requested = maturedBy.toISOString().replace('Z', '')
		if (!dataEnd || dataEnd >= requested) {
			return requested
		}

		this.logger.warn({
			actionCode: 'dataset.service.maturityCutoff.clamped',
			pluginId,
			requested,
			applied: dataEnd,
			reason:
				'history ends before the requested moment; labels beyond the edge have not matured',
		})
		return dataEnd
	}
}
