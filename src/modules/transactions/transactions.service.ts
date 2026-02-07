import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { TransactionModel } from 'generated/prisma/models/Transaction.js'

@Injectable()
export class TransactionsService {
	constructor(private prisma: PrismaService) {}

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
		const tx = await this.prisma.transaction.create({
			data: params
		})
		await this.applyBalanceEffect(tx)
		return tx
	}

	async applyBalanceEffect(tx: TransactionModel) {
		const useConverted =
			tx.convertedAmount != null && tx.convertToCurrency != null
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

	private async upsertAssetDelta(
		accountId: string,
		currency: string,
		delta: number
	) {
		await this.prisma.accountAsset.upsert({
			where: {
				accountId_currency: { accountId, currency }
			},
			update: { amount: { increment: delta } },
			create: { accountId, currency, amount: delta }
		})
	}
}
