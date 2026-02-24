import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { PrismaService } from '../../prisma/prisma.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { transactionsListKeyboard } from '../../../shared/keyboards/transactions'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { getCurrencySymbol } from '../../../utils/format'

const PAGE_SIZE = 9

async function renderTransactionsList(
	ctx: BotContext,
	prisma: PrismaService,
	page: number,
	analyticsService: AnalyticsService
) {
	const userId = ctx.state.user?.id
	if (!userId) return
	const mainCurrency = (ctx.state.user as any)?.mainCurrency ?? 'USD'
	const symbol = getCurrencySymbol(mainCurrency)
	const skip = page * PAGE_SIZE
	const now = new Date()
	const startOfMonth = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
	)
	const monthWhere = { userId, transactionDate: { gte: startOfMonth } }
	const [txs, totalCount, monthCount, monthExpense, monthIncome, monthTransfer] =
		await Promise.all([
			prisma.transaction.findMany({
				where: { userId },
				orderBy: { transactionDate: 'desc' },
				skip,
				take: PAGE_SIZE,
				include: { account: { include: { assets: true } }, toAccount: true, tag: true }
			}),
			prisma.transaction.count({ where: { userId } }),
			prisma.transaction.count({ where: monthWhere }),
			prisma.transaction.count({
				where: { ...monthWhere, direction: 'expense' }
			}),
			prisma.transaction.count({
				where: { ...monthWhere, direction: 'income' }
			}),
			prisma.transaction.count({
				where: { ...monthWhere, direction: 'transfer' }
			})
		])
	const [cashflow, burnRate] = await Promise.all([
		analyticsService.getCashflow(userId, 'month', mainCurrency),
		analyticsService.getBurnRate(userId, 'month', mainCurrency)
	])
	const monthName = new Date().toLocaleDateString('ru-RU', { month: 'long' })
	const msgId = ctx.callbackQuery?.message?.message_id
	if (msgId == null) return
	const isPremium = !!ctx.state.isPremium
	const monthLabel = isPremium
		? `${monthCount}`
		: `${monthCount}/30`
	const header = `📄 <b>Операции</b>

Всего: <b>${totalCount}</b>  
Текущий месяц: <b>${monthLabel}</b>

🔴 Расходы: ${monthExpense}  
🟢 Доходы: ${monthIncome}  
⚪ Переводы: ${monthTransfer}
Денежный поток (${monthName}): ${cashflow >= 0 ? '+' : ''}${Math.abs(cashflow).toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})} ${symbol}
Средний расход (${monthName}): ${burnRate.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})} ${symbol}`
	await ctx.api.editMessageText(ctx.chat!.id, msgId, header, {
		parse_mode: 'HTML',
		reply_markup: transactionsListKeyboard(txs, page, totalCount)
	})
}

function txToDraft(tx: any) {
	const accountCurrencies = new Set(
		(tx.account?.assets ?? []).map((a: any) => (a.currency || '').toUpperCase())
	)
	const currencyDeleted =
		tx.currency && accountCurrencies.size > 0 && !accountCurrencies.has(tx.currency.toUpperCase())
	return {
		action: 'create_transaction' as const,
		accountId: tx.accountId,
		account: tx.account?.name ?? null,
		amount: tx.amount,
		currency: tx.currency,
		direction: tx.direction,
		categoryId: tx.categoryId ?? undefined,
		category: tx.category ?? '📦Другое',
		description: tx.description ?? null,
		transactionDate: tx.transactionDate
			? new Date(tx.transactionDate).toISOString()
			: new Date().toISOString(),
		tagId: tx.tagId ?? undefined,
		tagName: tx.tag?.name ?? undefined,
		tagIsNew: false,
		convertToCurrency: tx.convertToCurrency ?? undefined,
		convertedAmount: tx.convertedAmount ?? undefined,
		toAccountId: tx.toAccountId ?? undefined,
		toAccount: tx.toAccount?.name ?? undefined,
		currencyDeleted
	}
}

export const viewTransactionsCallback = (
	bot: Bot<BotContext>,
	prisma: PrismaService,
	transactionsService: TransactionsService,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
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
		await renderTransactionsList(ctx, prisma, 0, analyticsService)
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
		await renderTransactionsList(ctx, prisma, page, analyticsService)
	})

	bot.callbackQuery(/^tx:/, async ctx => {
		const txId = ctx.callbackQuery.data.split(':')[1]
		const tx = await prisma.transaction.findUnique({
			where: { id: txId, userId: ctx.state.user.id },
			include: { account: { include: { assets: true } }, tag: true, toAccount: true }
		})
		if (!tx) return
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
			const draft = txToDraft(tx)
			;(draft as any).userTimezone =
				(ctx.state.user as any)?.timezone ?? 'UTC+02:00'
			ctx.session.draftTransactions = [draft]
		ctx.session.currentTransactionIndex = 0
		ctx.session.editingTransactionId = txId
		ctx.session.tempMessageId = msgId
		const user = ctx.state.user as any
		const showConversion = await getShowConversion(
			draft,
			tx.accountId,
			ctx.state.user.id,
			accountsService
		)
		const text = renderConfirmMessage(
			draft,
			0,
			1,
			user.defaultAccountId,
			undefined,
			'Детали транзакции'
		)
		const kb = confirmKeyboard(
			1,
			0,
			showConversion,
			draft.direction === 'transfer',
			true
		)
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
				categoryId: draft.categoryId ?? null,
				category: draft.category,
				description: draft.description,
			transactionDate: draft.transactionDate
				? new Date(draft.transactionDate)
				: undefined,
			tagId: draft.tagId ?? null,
			convertedAmount: draft.convertedAmount ?? null,
			convertToCurrency: draft.convertToCurrency ?? null,
			fromAccountId:
				draft.direction === 'transfer' ? (draft.accountId ?? null) : null,
			toAccountId: draft.toAccountId ?? null
		})
		ctx.session.editingTransactionId = undefined
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		const page = ctx.session.transactionsViewPage ?? 0
		await renderTransactionsList(ctx, prisma, page, analyticsService)
		await ctx.reply('✅ Транзакция обновлена.', {
			reply_markup: {
				inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]]
			}
		})
	})

	bot.callbackQuery('delete_transaction', async ctx => {
		const txId = ctx.session.editingTransactionId
		if (!txId) return
		if (ctx.session.tempMessageId == null) return
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.tempMessageId,
			'Удалить транзакцию?',
			{
				reply_markup: {
					inline_keyboard: [
						[
							{ text: 'Да', callback_data: 'delete_transaction_confirm_yes' },
							{ text: 'Нет', callback_data: 'delete_transaction_confirm_no' }
						]
					]
				}
			}
		)
	})

	bot.callbackQuery('delete_transaction_confirm_no', async ctx => {
		const txId = ctx.session.editingTransactionId
		const drafts = ctx.session.draftTransactions
		if (!txId || !drafts?.length || ctx.session.tempMessageId == null) return
		const draft = drafts[0] as any
		const user = ctx.state.user as any
		const showConversion = await getShowConversion(
			draft,
			draft.accountId ?? null,
			ctx.state.user.id,
			accountsService
		)
		const text = renderConfirmMessage(
			draft,
			0,
			1,
			user.defaultAccountId,
			undefined,
			'Детали транзакции'
		)
		const kb = confirmKeyboard(
			1,
			0,
			showConversion,
			draft.direction === 'transfer',
			true
		)
		await ctx.api.editMessageText(ctx.chat!.id, ctx.session.tempMessageId, text, {
			parse_mode: 'HTML',
			reply_markup: kb
		})
	})

	bot.callbackQuery('delete_transaction_confirm_yes', async ctx => {
		const txId = ctx.session.editingTransactionId
		if (!txId) return
		await transactionsService.delete(txId, ctx.state.user.id)
		ctx.session.editingTransactionId = undefined
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		ctx.session.tempMessageId = undefined
		const page = ctx.session.transactionsViewPage ?? 0
		ctx.session.transactionsViewPage = page
		await renderTransactionsList(ctx, prisma, page, analyticsService)
		await ctx.reply('✅ Транзакция удалена.', {
			reply_markup: {
				inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]]
			}
		})
	})

	bot.callbackQuery('back_to_transactions', async ctx => {
		ctx.session.editingTransactionId = undefined
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		ctx.session.tempMessageId = undefined
		const page = ctx.session.transactionsViewPage ?? 0
		await renderTransactionsList(ctx, prisma, page, analyticsService)
	})
}
