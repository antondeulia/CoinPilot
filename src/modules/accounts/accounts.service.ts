import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class AccountsService {
	constructor(private readonly prisma: PrismaService) {}

	async createAccount(userId: string, name: string, currency: string) {
		return this.prisma.account.create({
			data: {
				userId,
				name,
				currency,
				type: 'cash'
			}
		})
	}

	async setActive(userId: string, accountId: string) {
		return this.prisma.user.update({
			where: { id: userId },
			data: { activeAccountId: accountId }
		})
	}

	async getBalance({ userId }: { userId: string }): Promise<number> {
		const income = await this.prisma.transaction.aggregate({
			_sum: { amount: true },
			where: {
				direction: 'income',
				account: { userId }
			}
		})

		const expense = await this.prisma.transaction.aggregate({
			_sum: { amount: true },
			where: {
				direction: 'expense',
				account: { userId }
			}
		})

		return (income._sum.amount ?? 0) - (expense._sum.amount ?? 0)
	}
}
