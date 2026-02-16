import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { resetToHome } from '../utils/reset-home'

export const cancelTxCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('cancel_tx', async ctx => {
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined

		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}

		await resetToHome(ctx, accountsService, analyticsService)
	})
}
