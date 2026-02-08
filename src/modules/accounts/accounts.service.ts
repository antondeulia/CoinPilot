import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'
import { LlmAccount } from '../llm/schemas/account.schema'

@Injectable()
export class AccountsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly exchangeService: ExchangeService
	) {}

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

	/**
	 * Cashflow за текущий календарный месяц (1-е число — сегодня).
	 * Только income/expense, без внутренних переводов; валюта нормализуется в mainCurrency.
	 */
	async getBalance({
		userId,
		mainCurrency
	}: {
		userId: string
		mainCurrency?: string
	}): Promise<number> {
		const main =
			mainCurrency ??
			(
				await this.prisma.user.findUnique({
					where: { id: userId },
					select: { mainCurrency: true }
				})
			)?.mainCurrency ??
			'USD'

		const now = new Date()
		const startOfMonth = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
		)
		const endOfToday = new Date(
			Date.UTC(
				now.getUTCFullYear(),
				now.getUTCMonth(),
				now.getUTCDate(),
				23,
				59,
				59,
				999
			)
		)

		const txs = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: { in: ['income', 'expense'] },
				account: { userId, isHidden: false },
				transactionDate: { gte: startOfMonth, lte: endOfToday }
			},
			select: {
				direction: true,
				amount: true,
				currency: true,
				convertedAmount: true,
				convertToCurrency: true
			}
		})

		let inflowsMain = 0
		let outflowsMain = 0
		for (const tx of txs) {
			const useConverted =
				tx.convertedAmount != null &&
				tx.convertToCurrency != null &&
				tx.convertToCurrency === main
			const amountMain = useConverted
				? tx.convertedAmount!
				: await this.exchangeService.convert(tx.amount, tx.currency, main)
			if (tx.direction === 'income') inflowsMain += amountMain
			else outflowsMain += amountMain
		}
		return inflowsMain - outflowsMain
	}

	async createAccountWithAssets(userId: string, draft: LlmAccount) {
		const [firstWord, ...rest] = draft.name.trim().split(/\s+/)
		const formattedName =
			firstWord.charAt(0).toUpperCase() +
			firstWord.slice(1).toLowerCase() +
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
