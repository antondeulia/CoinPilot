import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { BotService } from './bot.service'
import { PremiumCronService } from './premium-cron.service'
import { UsersModule } from '../users/users.module'
import { TransactionsModule } from '../transactions/transactions.module'
import { LLMModule } from '../llm/llm.module'
import { AccountsModule } from '../accounts/accounts.module'
import { CategoriesModule } from '../categories/categories.module'
import { TagsModule } from '../tags/tags.module'
import { ExchangeModule } from '../exchange/exchange.module'
import { AnalyticsModule } from '../analytics/analytics.module'
import { SubscriptionModule } from '../subscription/subscription.module'
import { StripeModule } from '../stripe/stripe.module'

@Module({
	imports: [
		ScheduleModule.forRoot(),
		UsersModule,
		TransactionsModule,
		LLMModule,
		AccountsModule,
		CategoriesModule,
		TagsModule,
		ExchangeModule,
		AnalyticsModule,
		SubscriptionModule,
		StripeModule
	],
	providers: [BotService, PremiumCronService]
})
export class BotModule {}
