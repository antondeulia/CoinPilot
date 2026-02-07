import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { LlmAccount } from '../llm/schemas/account.schema'

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

	async getAllByUserId(userId: string) {
		return this.prisma.account.findMany({
			where: { userId, isHidden: false },
			orderBy: { createdAt: 'asc' }
		})
	}

	async getAllByUserIdIncludingHidden(userId: string) {
		return this.prisma.account.findMany({
			where: { userId },
			orderBy: { createdAt: 'asc' }
		})
	}

	async getAllWithAssets(userId: string) {
		return this.prisma.account.findMany({
			where: { userId, isHidden: false },
			include: { assets: true },
			orderBy: { createdAt: 'asc' }
		})
	}

	async getOneWithAssets(accountId: string, userId: string) {
		return this.prisma.account.findFirst({
			where: { id: accountId, userId },
			include: { assets: true }
		})
	}

	async updateAccountWithAssets(
		accountId: string,
		userId: string,
		draft: { name: string; assets: { currency: string; amount: number }[] }
	) {
		await this.prisma.$transaction(async tx => {
			await tx.account.update({
				where: { id: accountId, userId },
				data: { name: draft.name.trim() }
			})
			await tx.accountAsset.deleteMany({ where: { accountId } })
			for (const a of draft.assets) {
				await tx.accountAsset.create({
					data: { accountId, currency: a.currency, amount: a.amount }
				})
			}
		})
	}

	async findByName(userId: string, name: string) {
		return this.prisma.account.findFirst({
			where: {
				userId,
				name
			}
		})
	}

	async getBalance({ userId }: { userId: string }): Promise<number> {
		const income = await this.prisma.transaction.aggregate({
			_sum: { amount: true },
			where: {
				direction: 'income',
				account: { userId, isHidden: false }
			}
		})

		const expense = await this.prisma.transaction.aggregate({
			_sum: { amount: true },
			where: {
				direction: 'expense',
				account: { userId, isHidden: false }
			}
		})

		return (income._sum.amount ?? 0) - (expense._sum.amount ?? 0)
	}

	async createAccountWithAssets(userId: string, draft: LlmAccount) {
		const [firstWord, ...rest] = draft.name.trim().split(/\s+/)
		const formattedName =
			firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase() +
			(rest.length ? ' ' + rest.join(' ') : '')

		return this.prisma.$transaction(async tx => {
			const existingCount = await tx.account.count({ where: { userId } })
			const account = await tx.account.create({
				data: {
					userId,
					name: formattedName,
					type: 'bank',
					currency: draft.assets[0].currency
				}
			})

			for (const asset of draft.assets) {
				await tx.accountAsset.create({
					data: {
						accountId: account.id,
						currency: asset.currency,
						amount: asset.amount
					}
				})
			}

			if (existingCount === 0) {
				await tx.user.update({
					where: { id: userId },
					data: { defaultAccountId: account.id, activeAccountId: account.id }
				})
			}

			return account
		})
	}
}
