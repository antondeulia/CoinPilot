import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { renderHome } from '../utils/render-home'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { resetToHome } from '../utils/reset-home'

export const cancelTxCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
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

		await resetToHome(ctx, accountsService)
	})
}
