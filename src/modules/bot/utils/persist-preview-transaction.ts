import { BotContext } from '../core/bot.middleware'
import { TransactionsService } from '../../transactions/transactions.service'
import { normalizeTxDate } from '../../../utils/date'

export async function persistPreviewTransactionIfNeeded(
	ctx: BotContext,
	current: any,
	transactionsService: TransactionsService
): Promise<void> {
	const txId = current?.id ?? ctx.session.editingTransactionId
	if (!txId) return
	await transactionsService.update(txId, ctx.state.user.id, {
		accountId: current.accountId,
		amount: current.amount,
		currency: current.currency,
		direction: current.direction,
		tradeType: current.tradeType ?? null,
		tradeBaseCurrency: current.tradeBaseCurrency ?? null,
		tradeBaseAmount: current.tradeBaseAmount ?? null,
		tradeQuoteCurrency: current.tradeQuoteCurrency ?? null,
		tradeQuoteAmount: current.tradeQuoteAmount ?? null,
		executionPrice: current.executionPrice ?? null,
		tradeFeeCurrency: current.tradeFeeCurrency ?? null,
		tradeFeeAmount: current.tradeFeeAmount ?? null,
		categoryId: current.categoryId ?? null,
		category: current.category,
		description: current.description,
		rawText: current.rawText,
		transactionDate: normalizeTxDate(current.transactionDate) ?? undefined,
		tagId: current.tagId ?? null,
		convertedAmount: current.convertedAmount ?? null,
		convertToCurrency: current.convertToCurrency ?? null,
		fromAccountId:
			current.direction === 'transfer' ? (current.accountId ?? null) : null,
		toAccountId:
			current.toAccountId ??
			(current.tradeType && current.direction === 'transfer'
				? (current.accountId ?? null)
				: null)
	})
}

