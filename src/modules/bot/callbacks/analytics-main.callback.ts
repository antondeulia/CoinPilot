import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from '../../../modules/analytics/analytics.service'
import { formatAmount, getCurrencySymbol } from '../../../utils/format'

const MONTH_NAMES = [
	'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
	'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
]

function periodTitle(period: AnalyticsPeriod): string {
	if (period === '7d') return '7 дней'
	if (period === '30d') return '30 дней'
	if (period === '90d') return '90 дней'
	if (period === 'week') return 'текущую неделю'
	if (period === 'month') return MONTH_NAMES[new Date().getMonth()]
	if (period === '3month') return '3 месяца'
	return '3 месяца'
}

function analyticsKeyboard(period: AnalyticsPeriod) {
	const kb = new InlineKeyboard()
	kb.text(period === 'week' ? '✅ Неделя' : 'Неделя', 'analytics_week')
		.text(period === 'month' ? '✅ Месяц' : 'Месяц', 'analytics_month')
		.text(period === '3month' ? '✅ 3 месяца' : '3 месяца', 'analytics_3month')
		.row()
	kb.text(period === '7d' ? '✅ 7d' : '7d', 'analytics_7d')
		.text(period === '30d' ? '✅ 30d' : '30d', 'analytics_30d')
		.text(period === '90d' ? '✅ 90d' : '90d', 'analytics_90d')
		.row()
	// kb.text('По категориям', 'analytics_by_category')
	// 	.text('По тегам', 'analytics_by_tag')
	// 	.text('По типу', 'analytics_by_type')
	// 	.row()
	// kb.text('График', 'analytics_chart')
		// kb.text('Фильтр', 'analytics_filter')
		// 	.text('Сохранить вид', 'analytics_save_view')
		.text('Экспорт (CSV)', 'analytics_export')
		// .text('Уведомления', 'analytics_alerts')
		.row()
	// kb.text('График', 'analytics_chart')
	// 	.text('Уведомления', 'analytics_alerts')
	// 	.row()
	kb.text('← Назад', 'go_home')
	return kb
}

function fmt(num: number): string {
	return num.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
}

function fmtSigned(num: number): string {
	const sign = num > 0 ? '+' : num < 0 ? '-' : ''
	return `${sign}${fmt(Math.abs(num))}`
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
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

	const [summary, beginningBalance] = await Promise.all([
		analyticsService.getSummary(userId, period, mainCurrency, accountId),
		analyticsService.getBeginningBalance(userId, period, mainCurrency, accountId)
	])

	const [transfersTotal, cashflow, topCategories, topIncome, topTransfers] =
		await Promise.all([
		analyticsService.getTransfersTotal(userId, period, mainCurrency, accountId),
		analyticsService.getCashflow(userId, period, mainCurrency, accountId),
		analyticsService.getTopCategories(
			userId,
			period,
			mainCurrency,
			3,
			accountId,
			beginningBalance
		),
		analyticsService.getTopIncomeCategories(
			userId,
			period,
			mainCurrency,
			beginningBalance,
			3,
			accountId
		),
		analyticsService.getTopTransfers(
			userId,
			period,
			mainCurrency,
			1,
			accountId,
			beginningBalance
		)
	])

	const title = periodTitle(period)
	const days = analyticsService.getDateRange(period)
	const totalDays = Math.max(
		1,
		Math.ceil((days.to.getTime() - days.from.getTime()) / (24 * 60 * 60 * 1000))
	)
	const avgExpensePerDay = summary.expenses / totalDays
	const avgExpensePerDaySigned = avgExpensePerDay === 0 ? 0 : -Math.abs(avgExpensePerDay)
	const savingsRatio =
		summary.income > 0
			? Math.max(
					0,
					Math.round(((summary.income - summary.expenses) / summary.income) * 100)
				)
			: 0

	let body = `📊 Финансы — обзор за ${title}

Начало периода: ${fmt(beginningBalance)} ${symbol}
Текущий капитал: ${fmt(summary.balance)} ${symbol}

🔴 Расходы: −${fmt(summary.expenses)} ${symbol}
🟢 Доходы: +${fmt(summary.income)} ${symbol}
⚪ Переводы: ${fmt(transfersTotal)} ${symbol}

<b>Денежный поток:</b> ${fmtSigned(cashflow)} ${symbol}
<b>Средний расход в день:</b> ${fmtSigned(avgExpensePerDaySigned)} ${symbol}

Коэффициент сбережений: ${savingsRatio}%

— — —
`

	if (topCategories.length > 0) {
		body += '\n<b>Топ расходов:</b>\n'
		topCategories.forEach((c, i) => {
			body += `${i + 1}. ${c.categoryName} — ${c.sum.toFixed(0)} ${symbol} (${c.pct.toFixed(0)}%)\n`
			if (c.detailItems?.length) {
				const tagLine = c.detailItems
					.map(t => `${t.label} ${formatAmount(Math.abs(t.amount), t.currency)}`)
					.join(' · ')
				body += `<blockquote>${escapeHtml(tagLine)}</blockquote>\n`
			}
		})
	}

	if (topIncome.length > 0) {
		body += '\n<b>Топ доходов:</b>\n'
		topIncome.forEach((c, i) => {
			body += `${i + 1}. ${c.categoryName} — ${c.sum.toFixed(0)} ${symbol} (${c.pct.toFixed(0)}%)\n`
			if (c.detailItems?.length) {
				const tagLine = c.detailItems
					.map(t => `${t.label} ${formatAmount(Math.abs(t.amount), t.currency)}`)
					.join(' · ')
				body += `<blockquote>${escapeHtml(tagLine)}</blockquote>\n`
			}
		})
	}

	if (topTransfers.length > 0) {
		const t = topTransfers[0]
		body += `\n<b>Крупнейший перевод:</b>\n${t.fromAccountName} → ${t.toAccountName} — ${t.sum.toFixed(0)} ${symbol} (${t.pct.toFixed(0)}%)\n`
		if (t.detailItems?.length) {
			const line = t.detailItems
				.map(d => `${d.label} ${formatAmount(Math.abs(d.amount), d.currency)}`)
				.join(' · ')
			body += `<blockquote>${escapeHtml(line)}</blockquote>\n`
		}
	}

	return body.trim()
}

export const analyticsMainCallback = (
	bot: Bot<BotContext>,
	analyticsService: AnalyticsService
) => {
	async function sendOrEdit(ctx: BotContext, period: AnalyticsPeriod) {
		const isPremiumPeriod = period === '90d' || period === '3month'
		if (!ctx.state.isPremium && isPremiumPeriod) {
			await ctx.answerCallbackQuery()
			await ctx.reply(
				'📈 Расширенная аналитика (90 дней и 3 месяца) доступна только в Premium.\n\nПодключите Premium, чтобы видеть долгосрочные тренды и экспортировать данные.',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		;(ctx.session as any).analyticsPeriod = period
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		const text = await renderAnalyticsMain(
			ctx,
			analyticsService,
			period,
			accountId
		)
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
		await ctx.answerCallbackQuery()
	}

	bot.callbackQuery('view_analytics', async ctx => {
		;(ctx.session as any).navigationStack = [
			...(ctx.session.navigationStack ?? []),
			'home'
		]
		const period = ((ctx.session as any).analyticsPeriod ?? 'month') as AnalyticsPeriod
		await sendOrEdit(ctx, period)
	})

	bot.callbackQuery('analytics_week', async ctx => sendOrEdit(ctx, 'week'))
	bot.callbackQuery('analytics_month', async ctx => sendOrEdit(ctx, 'month'))
	bot.callbackQuery('analytics_3month', async ctx => sendOrEdit(ctx, '3month'))
	bot.callbackQuery('analytics_7d', async ctx => sendOrEdit(ctx, '7d'))
	bot.callbackQuery('analytics_30d', async ctx => sendOrEdit(ctx, '30d'))
	bot.callbackQuery('analytics_90d', async ctx => sendOrEdit(ctx, '90d'))

	bot.callbackQuery('analytics_back_to_main', async ctx => {
		const period = ((ctx.session as any).analyticsPeriod ?? 'month') as AnalyticsPeriod
		await sendOrEdit(ctx, period)
	})
}
