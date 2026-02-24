import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const editAmountCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('edit:amount', async ctx => {
		if (!ctx.session.draftTransactions || !ctx.session.draftTransactions.length) {
			return
		}
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = ctx.session.draftTransactions[index] as any
		const isTrade = current?.tradeType === 'buy' || current?.tradeType === 'sell'

		const kb = new InlineKeyboard().text('Закрыть', 'close_edit')

		const msg = await ctx.reply(
			isTrade
				? 'Введите новое количество базового актива (первая валюта пары).'
				: 'Введите новую сумму (только число, например 1234.56).',
			{
				reply_markup: kb
			}
		)

		ctx.session.awaitingTransaction = false
		ctx.session.awaitingAccountInput = false
		ctx.session.awaitingTagsJarvisEdit = false
		ctx.session.awaitingCategoryName = false
		ctx.session.awaitingTagInput = false
		ctx.session.editingTimezone = false
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingCurrency = false
		ctx.session.editingField = 'amount'
		ctx.session.editMessageId = msg.message_id
	})
}
