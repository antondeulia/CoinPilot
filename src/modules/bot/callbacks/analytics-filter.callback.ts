import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { type AnalyticsPeriod } from 'src/modules/analytics/analytics.service'

export const analyticsFilterCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('analytics_filter', async ctx => {
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const kb = new InlineKeyboard()
		kb.text(period === 7 ? '✅ 7d' : '7d', 'analytics_filter_period:7')
			.text(period === 30 ? '✅ 30d' : '30d', 'analytics_filter_period:30')
			.text(period === 90 ? '✅ 90d' : '90d', 'analytics_filter_period:90')
			.row()
		kb.text('← Назад', 'analytics_back_to_main')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					'<b>Фильтр аналитики</b>\nВыберите период:',
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^analytics_filter_period:/, async ctx => {
		const p = parseInt(ctx.callbackQuery.data.split(':')[1], 10) as AnalyticsPeriod
		;(ctx.session as any).analyticsPeriod = p
		await ctx.answerCallbackQuery({ text: `Период: ${p} дней` })
		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					'Фильтр применён. Обновите обзор кнопками 7d / 30d / 90d.',
					{
						reply_markup: new InlineKeyboard().text('← Назад', 'analytics_back_to_main')
					}
				)
			} catch {}
		}
	})
}
