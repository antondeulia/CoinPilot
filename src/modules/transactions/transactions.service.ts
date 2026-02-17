import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { TransactionModel } from '../../generated/prisma/models'
import { ExchangeService } from '../exchange/exchange.service'

@Injectable()
export class TransactionsService {
	constructor(
		private prisma: PrismaService,
		private readonly exchangeService: ExchangeService
	) {}

	async create(params: {
		userId: string
		accountId: string
		amount: number
		currency: string
		direction: 'income' | 'expense' | 'transfer'
		fromAccountId?: string
		toAccountId?: string
		category?: string
		description?: string
		rawText: string
		transactionDate?: Date
		tagId?: string
		convertedAmount?: number
		convertToCurrency?: string
	}) {
		const amountUsd = await this.exchangeService.convert(
			Math.abs(params.amount),
			params.currency,
			'USD'
		)
		const tx = await this.prisma.transaction.create({
			data: {
				...params,
				amount: Math.abs(params.amount),
				convertedAmount:
					params.convertedAmount != null
						? Math.abs(params.convertedAmount)
						: undefined,
				amountUsd: amountUsd ?? undefined
			}
		})
		await this.applyBalanceEffect(tx)
		return tx
	}

	async applyBalanceEffect(tx: TransactionModel) {
		const useConverted = tx.convertedAmount != null && tx.convertToCurrency != null
		const amountToUse = useConverted ? tx.convertedAmount! : tx.amount
		const currencyToUse = useConverted ? tx.convertToCurrency! : tx.currency

		if (tx.direction === 'expense') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, -amountToUse)
		} else if (tx.direction === 'income') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, amountToUse)
		} else if (tx.direction === 'transfer' && tx.toAccountId) {
			const fromId = tx.fromAccountId ?? tx.accountId
			await this.upsertAssetDelta(fromId, tx.currency, -tx.amount)
			await this.upsertAssetDelta(tx.toAccountId, currencyToUse, amountToUse)
		}
	}

	async reverseBalanceEffect(tx: TransactionModel) {
		const useConverted = tx.convertedAmount != null && tx.convertToCurrency != null
		const amountToUse = useConverted ? tx.convertedAmount! : tx.amount
		const currencyToUse = useConverted ? tx.convertToCurrency! : tx.currency

		if (tx.direction === 'expense') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, amountToUse)
		} else if (tx.direction === 'income') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, -amountToUse)
		} else if (tx.direction === 'transfer' && tx.toAccountId) {
			const fromId = tx.fromAccountId ?? tx.accountId
			await this.upsertAssetDelta(fromId, tx.currency, tx.amount)
			await this.upsertAssetDelta(tx.toAccountId, currencyToUse, -amountToUse)
		}
	}

	async update(
		id: string,
		userId: string,
		params: {
			accountId?: string
			amount?: number
			currency?: string
			direction?: 'income' | 'expense' | 'transfer'
			category?: string
			description?: string
			transactionDate?: Date
			tagId?: string | null
			convertedAmount?: number | null
			convertToCurrency?: string | null
			fromAccountId?: string | null
			toAccountId?: string | null
		}
	) {
		const existing = await this.prisma.transaction.findFirst({
			where: { id, userId }
		})
		if (!existing) return null
		await this.reverseBalanceEffect(existing as TransactionModel)
		const amountRaw = params.amount != null ? Math.abs(params.amount) : existing.amount
		const currencyRaw = params.currency ?? existing.currency
		const amountUsd = await this.exchangeService.convert(amountRaw, currencyRaw, 'USD')
		const updated = await this.prisma.transaction.update({
			where: { id },
			data: {
				...(params.accountId != null && { accountId: params.accountId }),
				...(params.amount != null && { amount: Math.abs(params.amount) }),
				...(params.currency != null && { currency: params.currency }),
				...(params.direction != null && { direction: params.direction }),
				...(params.category != null && { category: params.category }),
				...(params.description != null && { description: params.description }),
				...(params.transactionDate != null && {
					transactionDate: params.transactionDate
				}),
				...(params.tagId !== undefined && { tagId: params.tagId }),
				...(params.convertedAmount !== undefined && {
					convertedAmount:
						params.convertedAmount != null
							? Math.abs(params.convertedAmount)
							: null
				}),
				...(params.convertToCurrency !== undefined && {
					convertToCurrency: params.convertToCurrency
				}),
				...(params.fromAccountId !== undefined && {
					fromAccountId: params.fromAccountId
				}),
				...(params.toAccountId !== undefined && {
					toAccountId: params.toAccountId
				}),
				amountUsd: amountUsd ?? null
			}
		})
		await this.applyBalanceEffect(updated as TransactionModel)
		return updated
	}

	async delete(id: string, userId: string) {
		const tx = await this.prisma.transaction.findFirst({
			where: { id, userId }
		})
		if (!tx) return null
		await this.reverseBalanceEffect(tx as TransactionModel)
		await this.prisma.transaction.delete({ where: { id } })
		return tx
	}

	private async upsertAssetDelta(accountId: string, currency: string, delta: number) {
		await this.prisma.accountAsset.upsert({
			where: {
				accountId_currency: { accountId, currency }
			},
			update: { amount: { increment: delta } },
			create: { accountId, currency, amount: delta }
		})
	}
}
