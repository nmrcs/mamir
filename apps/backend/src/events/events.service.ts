import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import type { IngestEvent, IngestResult } from '@mamir/contracts'
import { z } from 'zod'
import type { Prisma } from '../generated/prisma/client'
import { PluginRegistryService } from '../plugins/plugin-registry.service'
import { PrismaService } from '../prisma/prisma.service'
import { ScoringService } from '../scoring/scoring.service'
import { WindowsService } from '../windows/windows.service'
import {
	compilePayloadSchema,
	extractEntityKeys,
	extractExposure,
	extractOccurredAt,
} from './event-payload'

@Injectable()
export class EventsService {
	private readonly logger = new Logger(EventsService.name)
	// The event schema is fixed within a plugin version — compiled once.
	private readonly schemas = new Map<string, z.ZodType>()

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly prisma: PrismaService,
		private readonly windows: WindowsService,
		private readonly scoring: ScoringService,
	) {}

	async ingest(input: IngestEvent): Promise<IngestResult> {
		const startedAt = Date.now()

		if (!this.registry.has(input.pluginId)) {
			throw new BadRequestException(
				`Plugin "${input.pluginId}" is not connected`,
			)
		}

		const plugin = this.registry.get(input.pluginId)
		const parsed = this.schemaFor(input.pluginId).safeParse(input.payload)

		if (!parsed.success) {
			this.logger.warn({
				actionCode: 'events.service.ingest.rejected',
				pluginId: input.pluginId,
				issues: parsed.error.issues.map(
					(issue) => `${issue.path.join('.')}: ${issue.message}`,
				),
			})
			throw new BadRequestException({
				message: 'The event does not match the plugin schema',
				issues: parsed.error.issues,
			})
		}

		const payload = parsed.data as Record<string, unknown>
		const occurredAt = extractOccurredAt(plugin.occurredAt, payload)
		const entityKeys = extractEntityKeys(plugin.entityKeys, payload)
		const exposure = extractExposure(plugin.exposure, payload)

		const event = await this.prisma.event.create({
			data: {
				pluginId: plugin.id,
				entityKeys,
				occurredAt,
				exposure,
				// The payload came from a JSON body and has already passed the
				// plugin schema — it is a JSON object by construction. The cast
				// is only needed to meet Prisma's nominal type.
				payload: payload as Prisma.InputJsonObject,
			},
			select: {
				id: true,
				occurredAt: true,
				ingestedAt: true,
				exposure: true,
			},
		})

		// The window's moment is the event's own ingestedAt, i.e. "what was
		// known by this second". The window bound is strict, so the event does
		// not see itself, and the row being already inserted does not affect
		// the result. Exactly this pair (vector, moment) is what
		// `windows --what verify` checks against the windowed form.
		const featureStartedAt = Date.now()
		const values = await this.windows.pointVector(
			plugin.id,
			entityKeys,
			event.ingestedAt,
		)
		const featureMs = Date.now() - featureStartedAt

		// The vector is written before scoring and independently of it: it is
		// a snapshot of what would go into the model, meaningful even when
		// there is nothing to score with.
		await this.prisma.featureVector.create({
			data: { eventId: event.id, values },
		})

		// The score goes into the response and the log, but NOT the DB: a
		// table of issued scores would be write-only — the model is seeded,
		// and any historical score is cheaper to reproduce from the stored
		// vector than to store.
		const score = await this.scoring.score(plugin.id, event.id, values)

		// No transaction on this path, deliberately: it would hold a DB
		// connection open for the whole HTTP call into a foreign service, and
		// the event must commit as early as possible — otherwise a neighboring
		// event with a larger ingestedAt would not see it in its window. The
		// "event exists, vector does not" state is normal anyway: the bulk
		// loader produces it, and materializeFeatures heals it via
		// ON CONFLICT DO UPDATE.
		this.logger.log({
			actionCode: 'events.service.ingest.accepted',
			pluginId: plugin.id,
			eventId: event.id,
			entities: Object.keys(entityKeys),
			features: Object.keys(values).length,
			featureMs,
			scoreMs: score?.latencyMs ?? null,
			totalMs: Date.now() - startedAt,
			scored: score !== null,
		})

		return {
			eventId: event.id,
			occurredAt: event.occurredAt.toISOString(),
			entityKeys,
			exposure: event.exposure.toString(),
			score: score && {
				modelVersion: score.modelVersion,
				raw: score.raw,
				probability: score.probability,
			},
		}
	}

	private schemaFor(pluginId: string): z.ZodType {
		const cached = this.schemas.get(pluginId)
		if (cached) {
			return cached
		}

		const compiled = compilePayloadSchema(this.registry.get(pluginId).event)
		this.schemas.set(pluginId, compiled)
		return compiled
	}
}
