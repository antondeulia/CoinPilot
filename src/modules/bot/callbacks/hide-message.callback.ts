import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const hideMessageCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('hide_message', async ctx => {
		try {
			await ctx.api.deleteMessage(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id
			)
		} catch {}
	})
}
