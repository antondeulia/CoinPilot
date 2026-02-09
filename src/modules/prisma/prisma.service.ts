import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../generated/prisma/client'

@Injectable()
export class PrismaService extends PrismaClient {
	constructor(private readonly config: ConfigService) {
		const adapter = new PrismaPg({
			connectionString: config.getOrThrow<string>('DATABASE_URL')
		})
		super({ adapter })
	}
}
