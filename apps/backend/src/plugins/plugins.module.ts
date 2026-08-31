import { Global, Module } from '@nestjs/common'
import { PluginRegistryService } from './plugin-registry.service'
import { PluginsController } from './plugins.controller'

@Global()
@Module({
	controllers: [PluginsController],
	providers: [PluginRegistryService],
	exports: [PluginRegistryService],
})
export class PluginsModule {}
