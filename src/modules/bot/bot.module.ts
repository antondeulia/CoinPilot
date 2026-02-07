import { Module } from '@nestjs/common'
import { BotService } from './bot.service'
import { UsersModule } from '../users/users.module'
import { TransactionsModule } from '../transactions/transactions.module'
import { LLMModule } from '../llm/llm.module'
import { AccountsModule } from '../accounts/accounts.module'
import { CategoriesModule } from '../categories/categories.module'
import { TagsModule } from '../tags/tags.module'
import { ExchangeModule } from '../exchange/exchange.module'
import { AnalyticsModule } from '../analytics/analytics.module'

@Module({
	imports: [
		UsersModule,
		TransactionsModule,
		LLMModule,
		AccountsModule,
		CategoriesModule,
		TagsModule,
		ExchangeModule,
		AnalyticsModule
	],
	providers: [BotService]
})
export class BotModule {}
