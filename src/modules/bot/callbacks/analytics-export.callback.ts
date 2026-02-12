import { Bot, InputFile, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { Parser } from 'json2csv'
import { PrismaService } from '../../../modules/prisma/prisma.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { PremiumEventType } from '../../../generated/prisma/enums'

export const analyticsExportCallback = (
	bot: Bot<BotContext>,
	prisma: PrismaService,
	subscriptionService: SubscriptionService
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
						.text('👑 Premium', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		const period = (ctx.session as any).analyticsPeriod ?? 30
		const from = new Date()
		from.setDate(from.getDate() - period)
		const txs = await prisma.transaction.findMany({
			where: {
				userId: user.id,
				transactionDate: { gte: from, lte: new Date() },
				account: { isHidden: false }
			},
			select: {
				id: true,
				amount: true,
				currency: true,
				direction: true,
				category: true,
				description: true,
				transactionDate: true,
				createdAt: true
			},
			orderBy: { transactionDate: 'desc' }
		})
		if (!txs.length) {
			await ctx.answerCallbackQuery({ text: 'Нет транзакций за период' })
			return
		}
		const parser = new Parser({
			fields: [
				'transactionDate',
				'direction',
				'amount',
				'currency',
				'category',
				'description'
			]
		})
		const csv = parser.parse(txs)
		const buffer = Buffer.from(csv, 'utf-8')
		await ctx.replyWithDocument(new InputFile(buffer, `transactions_${period}d.csv`))
		await ctx.answerCallbackQuery()
	})
}
