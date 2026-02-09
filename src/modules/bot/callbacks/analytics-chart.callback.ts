import { Bot, InputFile } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { type AnalyticsPeriod } from '../../../modules/analytics/analytics.service'
import { ExchangeService } from '../../../modules/exchange/exchange.service'
import { PrismaService } from '../../../modules/prisma/prisma.service'

export const analyticsChartCallback = (
	bot: Bot<BotContext>,
	prisma: PrismaService,
	exchangeService: ExchangeService
) => {
	bot.callbackQuery('analytics_chart', async ctx => {
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		const accountFilter = accountId
			? { accountId }
			: { account: { userId: user.id, isHidden: false } }
		const from = new Date()
		from.setDate(from.getDate() - period)
		const txs = await prisma.transaction.findMany({
			where: {
				userId: user.id,
				direction: 'expense',
				transactionDate: { gte: from, lte: new Date() },
				...accountFilter
			},
			select: {
				transactionDate: true,
				amount: true,
				currency: true,
				convertedAmount: true,
				convertToCurrency: true
			},
			orderBy: { transactionDate: 'asc' }
		})
		const mainCurrency = user.mainCurrency ?? 'USD'
		const byDay = new Map<string, number>()
		for (const t of txs) {
			const key = new Date(t.transactionDate).toLocaleDateString('ru-RU', {
				day: '2-digit',
				month: '2-digit'
			})
			const amt = t.convertedAmount ?? t.amount
			const cur = t.convertToCurrency ?? t.currency
			const inMain = await exchangeService.convert(amt, cur, mainCurrency)
			byDay.set(key, (byDay.get(key) ?? 0) + inMain)
		}
		const data = Array.from(byDay.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([date, value]) => ({ date, value }))
		if (!data.length) {
			await ctx.answerCallbackQuery({ text: 'Нет данных для графика' })
			return
		}
		await ctx.replyWithPhoto(new InputFile('', 'chart.png'), {
			caption: 'Расходы по дням'
		})
	})
}
