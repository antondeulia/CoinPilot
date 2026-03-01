import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { buildSettingsView } from '../../../shared/keyboards/settings'

export const analyticsAlertsCallback = (
	bot: Bot<BotContext>,
	prisma: {
		alertConfig: {
			count: (args: { where: { userId: string; enabled?: boolean } }) => Promise<number>
			updateMany: (args: {
				where: { userId: string }
				data: { enabled: boolean }
			}) => Promise<unknown>
			create: (args: {
					data: {
						userId: string
						type: 'large_expense'
						threshold: number
						thresholdDecimal?: string
						enabled: boolean
					}
				}) => Promise<unknown>
		}
	}
) => {
	bot.callbackQuery('analytics_alerts', async ctx => {
		const user: any = ctx.state.user
		if (!user?.id) return
		const enabledCount = await prisma.alertConfig.count({
			where: { userId: user.id, enabled: true }
		})
		if (enabledCount > 0) {
			await prisma.alertConfig.updateMany({
				where: { userId: user.id },
				data: { enabled: false }
			})
		} else {
			const anyCount = await prisma.alertConfig.count({
				where: { userId: user.id }
			})
			if (anyCount > 0) {
				await prisma.alertConfig.updateMany({
					where: { userId: user.id },
					data: { enabled: true }
				})
			} else {
					await prisma.alertConfig.create({
						data: {
							userId: user.id,
							type: 'large_expense',
							threshold: 100,
							thresholdDecimal: '100.000000000000000000',
							enabled: true
						}
					})
			}
		}
		const alertsEnabledCount = await prisma.alertConfig.count({
			where: { userId: user.id, enabled: true }
		})
		const view = buildSettingsView(user, alertsEnabledCount)
		const msgId = ctx.callbackQuery?.message?.message_id ?? (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(ctx.chat!.id, msgId, view.text, {
					parse_mode: 'HTML',
					reply_markup: view.keyboard
				})
			} catch {}
		}
		await ctx.answerCallbackQuery()
	})
}
