import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from 'src/modules/analytics/analytics.service'
import { getCurrencySymbol } from 'src/utils/format'

const ANOMALY_THRESHOLD = 100

function periodLabel(period: AnalyticsPeriod): string {
	if (period === 7) return '7 дней'
	if (period === 30) return '30 дней'
	return '90 дней'
}

function analyticsKeyboard(period: AnalyticsPeriod) {
	const kb = new InlineKeyboard()
	kb.text(period === 7 ? '✅ 7d' : '7d', 'analytics_7d')
		.text(period === 30 ? '✅ 30d' : '30d', 'analytics_30d')
		.text(period === 90 ? '✅ 90d' : '90d', 'analytics_90d')
		.row()
	// kb.text('По категориям', 'analytics_by_category')
	// 	.text('По тегам', 'analytics_by_tag')
	// 	.text('По типу', 'analytics_by_type')
	// 	.row()
	kb.text('График', 'analytics_chart')
		// kb.text('Фильтр', 'analytics_filter')
		// 	.text('Сохранить вид', 'analytics_save_view')
		.text('Экспорт', 'analytics_export')
		.text('Уведомления', 'analytics_alerts')
		.row()
	// kb.text('График', 'analytics_chart')
	// 	.text('Уведомления', 'analytics_alerts')
	// 	.row()
	kb.text('← Назад', 'go_home')
	return kb
}

export async function renderAnalyticsMain(
	ctx: BotContext,
	analyticsService: AnalyticsService,
	period: AnalyticsPeriod,
	accountId?: string
): Promise<string> {
	const user = ctx.state.user as any
	const userId = user.id
	const mainCurrency = user.mainCurrency ?? 'USD'
	const symbol = getCurrencySymbol(mainCurrency)

	const [summary, topCategories, topTags, anomalies] = await Promise.all([
		analyticsService.getSummary(userId, period, mainCurrency, accountId),
		analyticsService.getTopCategories(userId, period, mainCurrency, 5, accountId),
		analyticsService.getTopTags(userId, period, mainCurrency, 10, accountId),
		analyticsService.getAnomalies(
			userId,
			period,
			mainCurrency,
			ANOMALY_THRESHOLD,
			accountId
		)
	])

	const periodStr = periodLabel(period)
	let trendStr = ''
	if (summary.expensesTrendPct != null) {
		const sign = summary.expensesTrendPct >= 0 ? '↑' : '↓'
		trendStr = ` ${sign}${Math.abs(summary.expensesTrendPct).toFixed(0)}% vs prev`
	}

	const balanceStr = summary.balance.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
	const expensesStr = summary.expenses.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
	const incomeStr = summary.income.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})

	let categoriesBlock = ''
	if (topCategories.length) {
		categoriesBlock =
			'\nТоп категории:\n' +
			topCategories
				.map(
					(c, i) =>
						`${i + 1}. ${c.categoryName} ${c.sum.toFixed(0)} ${symbol} (${c.pct.toFixed(0)}%)`
				)
				.join('\n')
	}

	let tagsBlock = ''
	if (topTags.length) {
		tagsBlock =
			'\nТоп теги:\n' +
			topTags.map(t => `${t.tagName} ${t.sum.toFixed(0)} ${symbol}`).join(' · ')
	}

	const anomaliesLine =
		anomalies.length > 0
			? `\nАномалии: ${anomalies.length} крупных трат > ${ANOMALY_THRESHOLD} ${symbol}`
			: ''

	return `📊 Финансы — обзор за ${periodStr}

Баланс: ${balanceStr} ${symbol}
Расходы (${periodStr}): ${expensesStr} ${symbol}${trendStr}
Доходы (${periodStr}): ${incomeStr} ${symbol}
${categoriesBlock}${tagsBlock}${anomaliesLine}`
}

export const analyticsMainCallback = (
	bot: Bot<BotContext>,
	analyticsService: AnalyticsService
) => {
	async function sendOrEdit(ctx: BotContext, period: AnalyticsPeriod) {
		const user = ctx.state.user as any
		;(ctx.session as any).analyticsPeriod = period
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		const text = await renderAnalyticsMain(ctx, analyticsService, period, accountId)
		const kb = analyticsKeyboard(period)
		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(ctx.chat!.id, msgId, text, {
					parse_mode: 'HTML',
					reply_markup: kb
				})
			} catch {}
		}
	}

	bot.callbackQuery('view_analytics', async ctx => {
		;(ctx.session as any).navigationStack = [
			...(ctx.session.navigationStack ?? []),
			'home'
		]
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		await sendOrEdit(ctx, period)
	})

	bot.callbackQuery('analytics_7d', async ctx => sendOrEdit(ctx, 7))
	bot.callbackQuery('analytics_30d', async ctx => sendOrEdit(ctx, 30))
	bot.callbackQuery('analytics_90d', async ctx => sendOrEdit(ctx, 90))

	bot.callbackQuery('analytics_back_to_main', async ctx => {
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		await sendOrEdit(ctx, period)
	})
}
