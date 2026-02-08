import { Module } from '@nestjs/common'
import { AccountsService } from './accounts.service'
import { ExchangeModule } from '../exchange/exchange.module'

@Module({
	imports: [ExchangeModule],
	providers: [AccountsService],
	exports: [AccountsService]
})
export class AccountsModule {}
