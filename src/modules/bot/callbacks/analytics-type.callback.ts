import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from '../../../modules/analytics/analytics.service'
import { getCurrencySymbol } from '../../../utils/format'

export const analyticsTypeCallback = (
	bot: Bot<BotContext>,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('analytics_by_type', async ctx => {
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 'month') as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId

		const byType = await analyticsService.getByType(
			user.id,
			period,
			user.mainCurrency ?? 'USD',
			accountId
		)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')
		const periodStr =
			period === '7d' ? '7 дней' : period === '30d' ? '30 дней' : period === '90d' ? '90 дней' : period === 'week' ? 'неделю' : period === 'month' ? 'месяц' : '3 месяца'

		const text = `📊 <b>По типу за ${periodStr}</b>

Расходы: ${byType.expense.toFixed(2)} ${symbol}
Доходы: ${byType.income.toFixed(2)} ${symbol}
Переводы: ${byType.transfer.toFixed(2)} ${symbol}`

		const kb = new InlineKeyboard()
		kb.text('← Назад', 'analytics_back_to_main')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(ctx.chat!.id, msgId, text, {
					parse_mode: 'HTML',
					reply_markup: kb
				})
			} catch {}
		}
	})
}
