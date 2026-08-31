import { Module } from '@nestjs/common'
import { IngestService } from './ingest.service'

@Module({
	providers: [IngestService],
	exports: [IngestService],
})
export class IngestModule {}
