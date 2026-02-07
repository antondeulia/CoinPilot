import { AccountsService } from 'src/modules/accounts/accounts.service'
import { BotContext } from '../core/bot.middleware'
import { renderHome } from './render-home'

export async function resetToHome(ctx: BotContext, accountsService: AccountsService) {
	ctx.session.awaitingTransaction = false
	ctx.session.confirmingTransaction = false
	ctx.session.editingField = undefined
	ctx.session.draftTransactions = undefined

	if (ctx.session.tempMessageId) {
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
		} catch {}
		ctx.session.tempMessageId = undefined
	}

	await renderHome(ctx, accountsService)
}
