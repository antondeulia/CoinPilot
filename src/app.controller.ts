import { Controller, Get, Post } from '@nestjs/common'
import { PrismaService } from './modules/prisma/prisma.service'

@Controller('app')
export class AppController {
	constructor(private prisma: PrismaService) {}

	@Get('clear-db')
	async clearDatabase() {
		;(await this.prisma.transaction.deleteMany(),
			await this.prisma.account.deleteMany(),
			await this.prisma.category.deleteMany(),
			await this.prisma.user.deleteMany())

		return { message: 'Database cleared' }
	}
}
