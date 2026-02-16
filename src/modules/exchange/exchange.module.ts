import { Module, Global } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { ExchangeService } from './exchange.service'

@Global()
@Module({
	imports: [PrismaModule],
	providers: [ExchangeService],
	exports: [ExchangeService]
})
export class ExchangeModule {}
