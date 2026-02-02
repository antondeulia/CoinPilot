import { Module } from '@nestjs/common'
import { BotService } from './bot.service'
import { UsersModule } from '../users/users.module'
import { TransactionsModule } from '../transactions/transactions.module'
import { LLMModule } from '../llm/llm.module'
import { AccountsModule } from '../accounts/accounts.module'

@Module({
	imports: [UsersModule, TransactionsModule, LLMModule, AccountsModule],
	providers: [BotService]
})
export class BotModule {}
