import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { resetToHome } from '../utils/reset-home'
import { AccountsService } from 'src/modules/accounts/accounts.service'

export const editTxCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	bot.callbackQuery(/^edit:/, async ctx => {
		await ctx.answerCallbackQuery()

		const field = ctx.callbackQuery.data.split(':')[1] as
			| 'description'
			| 'amount'
			| 'date'
			| 'category'

		ctx.session.editingField = field

		await resetToHome(ctx, accountsService)
	})
}
