import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { accountSwitchKeyboard } from '../../../shared/keyboards'

export const accountsPaginationCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('accounts_page_current', async () => {})

	bot.callbackQuery(['accounts_page_prev', 'accounts_page_next'], async ctx => {
		const user = ctx.state.user
		const account = ctx.state.activeAccount
		if (!account) return

		const accounts = user.accounts
		const pageSize = 9
		const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))

		let page = ctx.session.accountsViewPage ?? 0

		if (ctx.callbackQuery.data === 'accounts_page_prev') {
			page = page <= 0 ? totalPages - 1 : page - 1
		} else {
			page = page >= totalPages - 1 ? 0 : page + 1
		}

		ctx.session.accountsViewPage = page

		await ctx.editMessageReplyMarkup({
			reply_markup: accountSwitchKeyboard(
				accounts,
				user.activeAccountId,
				page,
				ctx.session.accountsViewSelectedId ?? undefined,
				user.defaultAccountId ?? undefined
			)
		})
	})
}
