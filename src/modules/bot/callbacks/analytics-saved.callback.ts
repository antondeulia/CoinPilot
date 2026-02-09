import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { PrismaService } from '../../../modules/prisma/prisma.service'

export const analyticsSavedCallback = (bot: Bot<BotContext>, prisma: PrismaService) => {
	bot.callbackQuery('analytics_save_view', async ctx => {
		const userId = ctx.state.user.id
		const period = (ctx.session as any).analyticsPeriod ?? 30
		const accountId = (ctx.session as any).analyticsFilter?.accountId ?? null
		await prisma.savedAnalyticsView.create({
			data: {
				userId,
				name: `Обзор ${period}d`,
				filters: { period, accountId }
			}
		})
		await ctx.answerCallbackQuery({ text: 'Вид сохранён' })
	})
}
