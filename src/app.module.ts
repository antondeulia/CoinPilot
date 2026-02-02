import { Module } from '@nestjs/common'
import { BotModule } from './modules/bot/bot.module'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './modules/prisma/prisma.module'
import { UsersModule } from './modules/users/users.module'
import { TransactionsModule } from './modules/transactions/transactions.module'
import { LLMModule } from './modules/llm/llm.module'
import { AccountsModule } from './modules/accounts/accounts.module';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		PrismaModule,
		BotModule,
		UsersModule,
		TransactionsModule,
		LLMModule,
		AccountsModule
	]
})
export class AppModule {}
