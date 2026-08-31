import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(AppModule)

	app.enableCors({
		origin: ['http://localhost:3000'],
		allowedHeaders: ['Content-Type'],
		credentials: false,
	})

	const swaggerConfig = new DocumentBuilder()
		.setTitle('MAMIR Core')
		.setVersion('0.1.0')
		.build()
	SwaggerModule.setup(
		'docs',
		app,
		SwaggerModule.createDocument(app, swaggerConfig),
	)

	// Without an explicit host Nest listens on 0.0.0.0 — the dev server, /docs
	// and every ingest endpoint included, is visible to the whole local network.
	// It has no listeners from outside.
	const host = '127.0.0.1'
	const port = process.env.PORT ?? 3001
	await app.listen(port, host)
	new Logger('Bootstrap').log({
		actionCode: 'app.bootstrap.listen.ready',
		host,
		port,
		docsPath: '/docs',
	})
}

bootstrap()
