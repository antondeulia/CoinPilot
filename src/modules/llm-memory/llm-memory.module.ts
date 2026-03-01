import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { LlmMemoryService } from './llm-memory.service'

@Module({
	imports: [PrismaModule],
	providers: [LlmMemoryService],
	exports: [LlmMemoryService]
})
export class LlmMemoryModule {}

