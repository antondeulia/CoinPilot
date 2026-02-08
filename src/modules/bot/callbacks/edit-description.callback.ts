import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const editDescriptionCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('edit:description', async ctx => {
		if (!ctx.session.draftTransactions || !ctx.session.draftTransactions.length) {
			return
		}

		const kb = new InlineKeyboard().text('Закрыть', 'close_edit')

		const msg = await ctx.reply('Введите новое название для транзакции.', {
			reply_markup: kb
		})

		ctx.session.editingField = 'description'
		ctx.session.editMessageId = msg.message_id
	})
}
