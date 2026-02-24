import { Bot, InputFile, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { Parser } from 'json2csv'
import { PrismaService } from '../../../modules/prisma/prisma.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { PremiumEventType } from '../../../generated/prisma/enums'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from '../../../modules/analytics/analytics.service'

export const analyticsExportCallback = (
	bot: Bot<BotContext>,
	prisma: PrismaService,
	subscriptionService: SubscriptionService,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('analytics_export', async ctx => {
		const user = ctx.state.user as any
		const canExport = await subscriptionService.canExport(user.id)
		if (!canExport) {
			await subscriptionService.trackEvent(
				user.id,
				PremiumEventType.export_blocked
			)
			await ctx.answerCallbackQuery({
				text: '📊 Экспорт доступен в Premium. Выгружайте данные в CSV/Excel одним нажатием!'
			})
			await ctx.reply(
				'📊 Экспорт доступен в Premium. Выгружайте данные в CSV/Excel одним нажатием!',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		const period = ((ctx.session as any).analyticsPeriod ?? 'month') as AnalyticsPeriod
		const { from, to } = analyticsService.getDateRange(period)
		const txs = await prisma.transaction.findMany({
			where: {
				userId: user.id,
				transactionDate: { gte: from, lte: to },
				account: { isHidden: false }
			},
			select: {
				id: true,
				amount: true,
				currency: true,
				direction: true,
				category: true,
				description: true,
				convertedAmount: true,
				convertToCurrency: true,
				transactionDate: true,
				createdAt: true
			},
			orderBy: { transactionDate: 'desc' }
		})
		if (!txs.length) {
			await ctx.answerCallbackQuery({ text: 'Нет транзакций за период' })
			return
		}
		const currencies = await prisma.currency.findMany({
			select: { code: true, decimals: true }
		})
		const decimalsByCode = new Map(
			currencies.map(c => [c.code.toUpperCase(), Math.max(0, Math.min(18, c.decimals))])
		)
			const normalizeAmount = (
				value: number | { toNumber(): number },
				code?: string | null
			) => {
				const decimals = decimalsByCode.get(String(code ?? '').toUpperCase()) ?? 2
				const normalized = typeof value === 'number' ? value : value.toNumber()
				return Number(normalized.toFixed(decimals))
			}
		const exportRows = txs.map(tx => ({
			...tx,
			amount: normalizeAmount(tx.amount, tx.currency),
			convertedAmount:
				tx.convertedAmount != null
					? normalizeAmount(tx.convertedAmount, tx.convertToCurrency ?? tx.currency)
					: null
		}))
		const parser = new Parser({
			fields: [
				'transactionDate',
				'direction',
				'amount',
				'currency',
				'convertedAmount',
				'convertToCurrency',
				'category',
				'description'
			]
		})
		const csv = parser.parse(exportRows)
		const buffer = Buffer.from(csv, 'utf-8')
		await ctx.replyWithDocument(new InputFile(buffer, `transactions_${period}.csv`))
		await ctx.answerCallbackQuery()
	})
}
