import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { PrismaService } from '../../prisma/prisma.service'
import {
	transactionsListKeyboard,
	transactionDetailKeyboard
} from 'src/shared/keyboards/transactions'

const PAGE_SIZE = 9

async function renderTransactionsList(
	ctx: BotContext,
	prisma: PrismaService,
	page: number
) {
	const account = ctx.state.activeAccount
	if (!account) return
	const skip = page * PAGE_SIZE
	const [txs, totalCount] = await Promise.all([
		prisma.transaction.findMany({
			where: { accountId: account.id },
			orderBy: { createdAt: 'desc' },
			skip,
			take: PAGE_SIZE
		}),
		prisma.transaction.count({ where: { accountId: account.id } })
	])
	const msgId = ctx.callbackQuery?.message?.message_id
	if (msgId == null) return
	await ctx.api.editMessageText(ctx.chat!.id, msgId, '<b>Транзакции</b>', {
		parse_mode: 'HTML',
		reply_markup: transactionsListKeyboard(txs, page, totalCount)
	})
}

export const viewTransactionsCallback = (
	bot: Bot<BotContext>,
	prisma: PrismaService
) => {
	bot.callbackQuery('view_transactions', async ctx => {
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
		const account = ctx.state.activeAccount
		if (!account) return
		ctx.session.navigationStack = [...(ctx.session.navigationStack ?? []), 'home']
		ctx.session.transactionsViewPage = 0
		await renderTransactionsList(ctx, prisma, 0)
	})

	bot.callbackQuery(/^transactions_page:(prev|next|noop)$/, async ctx => {
		const dir = ctx.callbackQuery.data.split(':')[1]
		if (dir === 'noop') return
		let page = ctx.session.transactionsViewPage ?? 0
		const account = ctx.state.activeAccount
		if (!account) return
		const totalCount = await prisma.transaction.count({
			where: { accountId: account.id }
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
			where: { id: txId }
		})
		if (!tx) return
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		const text = `
<b>Транзакция</b>

Тип: ${tx.direction === 'expense' ? 'Расход' : 'Доход'}
Сумма: ${tx.amount} ${tx.currency}
Категория: ${tx.category ?? '—'}
Описание: ${tx.description ?? '—'}
Дата: ${new Date(tx.createdAt).toLocaleString('ru-RU')}
`
		await ctx.api.editMessageText(ctx.chat!.id, msgId, text.trim(), {
			parse_mode: 'HTML',
			reply_markup: transactionDetailKeyboard()
		})
	})

	bot.callbackQuery('back_to_transactions', async ctx => {
		const page = ctx.session.transactionsViewPage ?? 0
		await renderTransactionsList(ctx, prisma, page)
	})
}
