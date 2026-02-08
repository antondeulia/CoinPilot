import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { PrismaService } from '../../prisma/prisma.service'
import { TransactionsService } from 'src/modules/transactions/transactions.service'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import {
	transactionsListKeyboard,
	transactionDetailKeyboard
} from 'src/shared/keyboards/transactions'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

const PAGE_SIZE = 9

async function renderTransactionsList(
	ctx: BotContext,
	prisma: PrismaService,
	page: number
) {
	const userId = ctx.state.user?.id
	if (!userId) return
	const skip = page * PAGE_SIZE
	const [txs, totalCount] = await Promise.all([
		prisma.transaction.findMany({
			where: { userId },
			orderBy: { transactionDate: 'desc' },
			skip,
			take: PAGE_SIZE
		}),
		prisma.transaction.count({ where: { userId } })
	])
	const msgId = ctx.callbackQuery?.message?.message_id
	if (msgId == null) return
	await ctx.api.editMessageText(ctx.chat!.id, msgId, '<b>Транзакции</b>', {
		parse_mode: 'HTML',
		reply_markup: transactionsListKeyboard(txs, page, totalCount)
	})
}

function txToDraft(tx: any) {
	return {
		action: 'create_transaction' as const,
		accountId: tx.accountId,
		account: tx.account?.name ?? null,
		amount: tx.amount,
		currency: tx.currency,
		direction: tx.direction,
		category: tx.category ?? 'Не выбрано',
		description: tx.description ?? null,
		transactionDate: tx.transactionDate ? new Date(tx.transactionDate).toISOString() : new Date().toISOString(),
		tagId: tx.tagId ?? undefined,
		tagName: tx.tag?.name ?? undefined,
		tagIsNew: false,
		convertToCurrency: tx.convertToCurrency ?? undefined,
		convertedAmount: tx.convertedAmount ?? undefined,
		toAccountId: tx.toAccountId ?? undefined,
		toAccount: tx.toAccount?.name ?? undefined
	}
}

export const viewTransactionsCallback = (
	bot: Bot<BotContext>,
	prisma: PrismaService,
	transactionsService: TransactionsService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('view_transactions', async ctx => {
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
		if (!ctx.state.user?.id) return
		ctx.session.navigationStack = [...(ctx.session.navigationStack ?? []), 'home']
		ctx.session.transactionsViewPage = 0
		await renderTransactionsList(ctx, prisma, 0)
	})

	bot.callbackQuery(/^transactions_page:(prev|next|noop)$/, async ctx => {
		const dir = ctx.callbackQuery.data.split(':')[1]
		if (dir === 'noop') return
		let page = ctx.session.transactionsViewPage ?? 0
		const userId = ctx.state.user?.id
		if (!userId) return
		const totalCount = await prisma.transaction.count({
			where: { userId }
		})
		const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
		if (dir === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		else page = page >= totalPages - 1 ? 0 : page + 1
		ctx.session.transactionsViewPage = page
		await renderTransactionsList(ctx, prisma, page)
	})

	bot.callbackQuery(/^tx:/, async ctx => {
		const txId = ctx.callbackQuery.data.split(':')[1]
		const tx = await prisma.transaction.findUnique({
			where: { id: txId, userId: ctx.state.user.id },
			include: { account: true, tag: true, toAccount: true }
		})
		if (!tx) return
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		const draft = txToDraft(tx)
		ctx.session.draftTransactions = [draft]
		ctx.session.currentTransactionIndex = 0
		ctx.session.editingTransactionId = txId
		ctx.session.tempMessageId = msgId
		const user = ctx.state.user as any
		const showConversion = await getShowConversion(draft, tx.accountId, ctx.state.user.id, accountsService)
		const text = renderConfirmMessage(draft, 0, 1, user.defaultAccountId, undefined, 'Детали транзакции')
		const kb = confirmKeyboard(1, 0, showConversion, draft.direction === 'transfer', true)
		await ctx.api.editMessageText(ctx.chat!.id, msgId, text, {
			parse_mode: 'HTML',
			reply_markup: kb
		})
	})

	bot.callbackQuery('save_edit_transaction', async ctx => {
		const txId = ctx.session.editingTransactionId
		const drafts = ctx.session.draftTransactions
		if (!txId || !drafts?.length) return
		const draft = drafts[0] as any
		await transactionsService.update(txId, ctx.state.user.id, {
			accountId: draft.accountId,
			amount: draft.amount,
			currency: draft.currency,
			direction: draft.direction,
			category: draft.category,
			description: draft.description,
			transactionDate: draft.transactionDate ? new Date(draft.transactionDate) : undefined,
			tagId: draft.tagId ?? null,
			convertedAmount: draft.convertedAmount ?? null,
			convertToCurrency: draft.convertToCurrency ?? null,
			fromAccountId: draft.direction === 'transfer' ? (draft.accountId ?? null) : null,
			toAccountId: draft.toAccountId ?? null
		})
		ctx.session.editingTransactionId = undefined
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		const page = ctx.session.transactionsViewPage ?? 0
		await renderTransactionsList(ctx, prisma, page)
		await ctx.reply('✅ Транзакция обновлена.', {
			reply_markup: { inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]] }
		})
	})

	bot.callbackQuery('delete_transaction', async ctx => {
		const txId = ctx.session.editingTransactionId
		if (!txId) return
		await transactionsService.delete(txId, ctx.state.user.id)
		ctx.session.editingTransactionId = undefined
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		ctx.session.tempMessageId = undefined
		const page = ctx.session.transactionsViewPage ?? 0
		ctx.session.transactionsViewPage = page
		await renderTransactionsList(ctx, prisma, page)
		await ctx.reply('✅ Транзакция удалена.', {
			reply_markup: { inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]] }
		})
	})

	bot.callbackQuery('back_to_transactions', async ctx => {
		ctx.session.editingTransactionId = undefined
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		const page = ctx.session.transactionsViewPage ?? 0
		await renderTransactionsList(ctx, prisma, page)
	})
}
