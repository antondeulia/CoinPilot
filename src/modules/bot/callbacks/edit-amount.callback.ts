import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const editAmountCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('edit:amount', async ctx => {
		if (!ctx.session.draftTransactions || !ctx.session.draftTransactions.length) {
			return
		}

		const kb = new InlineKeyboard().text('Закрыть', 'close_edit')

		const msg = await ctx.reply(
			'Введите новую сумму (только число, например 1234.56).',
			{
				reply_markup: kb
			}
		)

		ctx.session.editingField = 'amount'
		ctx.session.editMessageId = msg.message_id
	})
}
