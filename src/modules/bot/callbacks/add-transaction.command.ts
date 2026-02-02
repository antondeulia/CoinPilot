import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const addTxCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('add_transaction', async ctx => {
		await ctx.answerCallbackQuery()

		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
			} catch {}
		}

		ctx.session.awaitingTransaction = true

		const msg = await ctx.reply(
			`➕ <b>Добавь транзакцию</b>

Можно:
• написать текстом  
• отправить фото чека`,
			{
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard().text(
					'Закрыть',
					'close_add_transaction'
				)
			}
		)

		ctx.session.tempMessageId = msg.message_id
	})
}
