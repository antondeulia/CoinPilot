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
		category: current.category,
		description: current.description,
		transactionDate: normalizeTxDate(current.transactionDate) ?? undefined,
		tagId: current.tagId ?? null,
		convertedAmount: current.convertedAmount ?? null,
		convertToCurrency: current.convertToCurrency ?? null,
		fromAccountId:
			current.direction === 'transfer' ? (current.accountId ?? null) : null,
		toAccountId: current.toAccountId ?? null
	})
}

