import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { parse } from 'csv-parse'
import { Client } from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import type { DomainPlugin } from '@mamir/contracts'
import type { Env } from '../config/env'
import {
	compilePayloadSchema,
	extractEntityKeys,
	extractExposure,
	extractOccurredAt,
} from '../events/event-payload'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'
import { coerceRow } from './coerce'
import { SourceDescriptor } from './source-descriptor'

export interface IngestOptions {
	pluginId: string
	source: string
	dataDir: string
	limit?: number
	// Substituted into the descriptor's file names: the dataset is split into
	// cohorts (in SFLLD — by origination year), while the file shape stays
	// the same.
	cohort?: string
	// Reload a slice already marked as finished.
	force?: boolean
}

export interface IngestReport {
	status: 'loaded' | 'skipped'
	accepted: number
	rejected: number
	joined: number
	elapsedMs: number
	rowsPerSec: number
	// Range of ingested moments. The time unit is set by the plugin, and a
	// mistake in it is rejected by no check — `200612` read as milliseconds
	// yields a valid 1970 event. Hence the range is always in the report: a
	// domain history that fits into seconds is visible at once.
	occurredFrom: string | null
	occurredTo: string | null
}

type Row = Record<string, string>

// No id: DEFAULT uuidv7() in Postgres sets it — see the comment in the schema.
const COLUMNS =
	'"pluginId", "entityKeys", "occurredAt", "ingestedAt", exposure, payload, "ingestRunId"'

// Historical load. The key difference from `POST /events`: ingestedAt is
// set equal to occurredAt. This is backfill — the data is declared known at
// the same moment it occurred. A prod stream must never do this: there
// ingestedAt = time of receipt, and point-in-time rests on exactly that
// distinction.
//
// The loader writes no labels: since the label became a forward window, it
// is computed by a pass over the already loaded history, not from one row.
//
// Writes via COPY, not Prisma: on 26M events the difference is threefold,
// and a parameterized INSERT protects nothing here — the data has already
// passed the plugin schema one line above.
@Injectable()
export class IngestService {
	private readonly logger = new Logger(IngestService.name)

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<Env, true>,
	) {}

	async fromSource(options: IngestOptions): Promise<IngestReport> {
		const plugin = this.registry.get(options.pluginId)
		const descriptor = SourceDescriptor.parse(
			JSON.parse(await readFile(options.source, 'utf8')),
		)
		const cohort = options.cohort ?? ''
		const startedAt = Date.now()

		const previous = await this.prisma.ingestRun.findUnique({
			where: { pluginId_cohort: { pluginId: plugin.id, cohort } },
		})

		if (previous?.finishedAt && !options.force) {
			this.logger.log({
				actionCode: 'ingest.service.fromSource.skipped',
				pluginId: plugin.id,
				cohort,
				accepted: previous.accepted,
			})
			return {
				status: 'skipped',
				accepted: previous.accepted,
				rejected: previous.rejected,
				joined: 0,
				elapsedMs: 0,
				rowsPerSec: 0,
				occurredFrom: null,
				occurredTo: null,
			}
		}

		if (previous) {
			// Either an interrupted run or an explicit reload. In both cases
			// its events go away: there is no way to top up half a slice —
			// csv-parse does not report where exactly the stream broke off.
			const removed = await this.prisma.event.deleteMany({
				where: { ingestRunId: previous.id },
			})
			await this.prisma.ingestRun.delete({ where: { id: previous.id } })
			this.logger.warn({
				actionCode: 'ingest.service.fromSource.reset',
				pluginId: plugin.id,
				cohort,
				removed: removed.count,
				reason: previous.finishedAt ? 'force' : 'interrupted',
			})
		}

		const run = await this.prisma.ingestRun.create({
			data: { pluginId: plugin.id, cohort },
		})

		const lookup = descriptor.join
			? await this.loadLookup(options, descriptor, plugin)
			: null

		const stats: Stats = {
			accepted: 0,
			rejected: 0,
			joined: 0,
			from: null,
			to: null,
		}

		const client = new Client({
			connectionString: this.config.get('DATABASE_URL', { infer: true }),
		})
		await client.connect()

		try {
			await pipeline(
				Readable.from(
					this.copyLines({
						options,
						descriptor,
						plugin,
						lookup,
						run: run.id,
						stats,
					}),
				),
				client.query(copyFrom(`COPY "Event" (${COLUMNS}) FROM STDIN`)),
			)
		} finally {
			await client.end()
		}

		await this.prisma.ingestRun.update({
			where: { id: run.id },
			data: {
				// A run with --limit is not marked finished: the slice is not
				// fully loaded, and "finished" here would be exactly the lie
				// about state the ingest run journal exists to prevent.
				finishedAt: options.limit === undefined ? new Date() : null,
				accepted: stats.accepted,
				rejected: stats.rejected,
			},
		})

		const elapsedMs = Date.now() - startedAt
		const report: IngestReport = {
			status: 'loaded',
			accepted: stats.accepted,
			rejected: stats.rejected,
			joined: stats.joined,
			elapsedMs,
			rowsPerSec: Math.round((stats.accepted / elapsedMs) * 1000),
			occurredFrom: stats.from?.toISOString() ?? null,
			occurredTo: stats.to?.toISOString() ?? null,
		}

		this.logger.log({
			actionCode: 'ingest.service.fromSource.completed',
			pluginId: plugin.id,
			cohort,
			...report,
		})

		return report
	}

	// Rows for COPY in text format. A generator, not an array: 3M events do
	// not fit in memory, and a stream gives natural backpressure — the
	// parser slows down exactly when Postgres cannot keep up.
	private async *copyLines(ctx: {
		options: IngestOptions
		descriptor: SourceDescriptor
		plugin: DomainPlugin
		lookup: Map<string, Row> | null
		run: string
		stats: Stats
	}): AsyncGenerator<string> {
		const { options, descriptor, plugin, lookup, run, stats } = ctx
		const schema = compilePayloadSchema(plugin.event)

		const parser = createReadStream(
			joinPath(options.dataDir, resolveFile(descriptor.main.file, options)),
		).pipe(
			parse({
				delimiter: descriptor.delimiter,
				columns: descriptor.header ? true : descriptor.main.columns,
				skipEmptyLines: true,
			}),
		)

		for await (const row of parser as AsyncIterable<Row>) {
			if (
				options.limit !== undefined &&
				stats.accepted + stats.rejected >= options.limit
			) {
				break
			}

			let merged = row
			if (lookup && descriptor.join) {
				const extra = lookup.get(row[descriptor.join.on])
				if (extra) {
					merged = { ...extra, ...row }
					stats.joined++
				}
			}

			const parsed = schema.safeParse(coerceRow(plugin.event, merged))
			if (!parsed.success) {
				stats.rejected++
				if (stats.rejected <= 3) {
					this.logger.warn({
						actionCode: 'ingest.service.fromSource.rejected',
						issues: parsed.error.issues.map(
							(issue) => `${issue.path.join('.')}: ${issue.message}`,
						),
					})
				}
				continue
			}

			const payload = parsed.data as Record<string, unknown>
			const occurredAt = extractOccurredAt(plugin.occurredAt, payload)
			const at = occurredAt.toISOString()

			if (stats.from === null || occurredAt < stats.from)
				stats.from = occurredAt
			if (stats.to === null || occurredAt > stats.to) stats.to = occurredAt
			stats.accepted++

			yield `${plugin.id}\t` +
				`${escapeCopy(JSON.stringify(extractEntityKeys(plugin.entityKeys, payload)))}\t` +
				`${at}\t${at}\t${extractExposure(plugin.exposure, payload)}\t` +
				`${escapeCopy(JSON.stringify(payload))}\t${run}\n`
		}
	}

	// The lookup is kept in memory: otherwise every row of the main file
	// would cost a DB query. Only fields declared by the domain are stored —
	// size is bounded by what is actually used, not by the file's width.
	private async loadLookup(
		options: IngestOptions,
		descriptor: SourceDescriptor,
		plugin: DomainPlugin,
	): Promise<Map<string, Row>> {
		const spec = descriptor.join
		if (!spec) {
			throw new Error('loadLookup called without a join spec')
		}

		const declared = new Set(Object.keys(plugin.event))
		const lookup = new Map<string, Row>()

		const parser = createReadStream(
			joinPath(options.dataDir, resolveFile(spec.file, options)),
		).pipe(
			parse({
				delimiter: descriptor.delimiter,
				columns: descriptor.header ? true : spec.columns,
				skipEmptyLines: true,
			}),
		)

		for await (const row of parser as AsyncIterable<Row>) {
			const kept: Row = {}
			for (const [key, value] of Object.entries(row)) {
				if (declared.has(key)) {
					kept[key] = value
				}
			}
			lookup.set(row[spec.on], kept)
		}

		this.logger.log({
			actionCode: 'ingest.service.loadLookup.ready',
			file: resolveFile(spec.file, options),
			keys: lookup.size,
			fields: declared.size,
		})

		return lookup
	}
}

interface Stats {
	accepted: number
	rejected: number
	joined: number
	from: Date | null
	to: Date | null
}

// COPY text format separates fields with tabs and rows with newlines. A
// value containing them or a backslash must be escaped — otherwise one cell
// with a line break shifts the whole rest of the file by a column.
function escapeCopy(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/\t/g, '\\t')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
}

function resolveFile(pattern: string, options: IngestOptions): string {
	return pattern.replace('{cohort}', options.cohort ?? '')
}
