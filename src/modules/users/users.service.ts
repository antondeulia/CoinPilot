import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class UsersService {
	constructor(private prisma: PrismaService) {}

	async getOrCreateByTelegramId(telegramId: string) {
		const existing = await this.prisma.user.findUnique({
			where: { telegramId },
			include: { accounts: true }
		})

		if (existing) return existing

		const user = await this.prisma.user.create({
			data: {
				telegramId,
				accounts: {
					create: {
						name: 'Cash',
						type: 'cash',
						currency: 'EUR'
					}
				}
			},
			include: { accounts: true }
		})

		const account = user.accounts[0]

		await this.prisma.user.update({
			where: { id: user.id },
			data: { activeAccountId: account.id }
		})

		return {
			...user,
			activeAccountId: account.id
		}
	}
}
