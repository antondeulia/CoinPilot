import { Bot, InputFile } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { Parser } from 'json2csv'
import { PrismaService } from 'src/modules/prisma/prisma.service'

export const analyticsExportCallback = (bot: Bot<BotContext>, prisma: PrismaService) => {
	bot.callbackQuery('analytics_export', async ctx => {
		const user = ctx.state.user as any
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
