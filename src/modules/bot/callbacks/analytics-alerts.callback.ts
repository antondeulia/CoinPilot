import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const analyticsAlertsCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('analytics_alerts', async ctx => {
		const kb = new InlineKeyboard().text('← Назад', 'analytics_back_to_main')
		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					'<b>Уведомления</b>\n\nНастройка порогов — в разработке.',
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})
}
