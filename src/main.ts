import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ConfigService } from '@nestjs/config'
import * as express from 'express'

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {bodyParser: false, // отключаем встроенный парсер
	})

	// Stripe webhook должен получать raw body
	app.use(
		'/stripe/webhook',
		express.raw({ type: 'application/json' }) as any
	)

	const config = app.get(ConfigService)

	await app.listen(config.getOrThrow<string>('PORT'))
}
bootstrap()
