import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { BotModule } from './modules/bot/bot.module'
import { PrismaModule } from './modules/prisma/prisma.module'
import { UsersModule } from './modules/users/users.module'
import { TransactionsModule } from './modules/transactions/transactions.module'
import { LLMModule } from './modules/llm/llm.module'
import { AccountsModule } from './modules/accounts/accounts.module'
import { ExchangeModule } from './modules/exchange/exchange.module'
import { AnalyticsModule } from './modules/analytics/analytics.module'
import { AppController } from './app.controller'

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		PrismaModule,
		ExchangeModule,
		BotModule,
		UsersModule,
		TransactionsModule,
		LLMModule,
		AccountsModule,
		AnalyticsModule
	],
	controllers: [AppController]
})
export class AppModule {}
