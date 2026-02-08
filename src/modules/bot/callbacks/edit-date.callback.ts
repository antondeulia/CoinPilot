import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const editDateCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('edit:date', async ctx => {
		if (!ctx.session.draftTransactions || !ctx.session.draftTransactions.length) {
			return
		}

		const kb = new InlineKeyboard().text('Закрыть', 'close_edit')

		const msg = await ctx.reply(
			'Введите дату: Сегодня, Вчера или конкретную дату (например, 12.01.2026 или 2026-01-12).',
			{ reply_markup: kb }
		)

		ctx.session.editingField = 'date'
		ctx.session.editMessageId = msg.message_id
	})
}
