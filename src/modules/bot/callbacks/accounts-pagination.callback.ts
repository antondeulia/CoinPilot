import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { accountSwitchKeyboard } from '../../../shared/keyboards'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'

export const accountsPaginationCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('accounts_page_current', async () => {})

	bot.callbackQuery(['accounts_page_prev', 'accounts_page_next'], async ctx => {
		const user = ctx.state.user
		if (!user) return

		const accounts = await accountsService.getAllByUserId(user.id)
		const pageSize = 9
		const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))

		let page = ctx.session.accountsViewPage ?? 0

		if (ctx.callbackQuery.data === 'accounts_page_prev') {
			page = page <= 0 ? totalPages - 1 : page - 1
		} else {
			page = page >= totalPages - 1 ? 0 : page + 1
		}

		ctx.session.accountsViewPage = page

		const frozen = await subscriptionService.getFrozenItems(user.id)
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const selectedId = ctx.session.accountsViewSelectedId ?? undefined
		const selectedFrozen = selectedId ? frozenAccountIds.has(selectedId) : false
		await ctx.editMessageReplyMarkup({
			reply_markup: accountSwitchKeyboard(
				accounts,
				user.activeAccountId,
				page,
				selectedId,
				user.defaultAccountId ?? undefined,
				frozenAccountIds,
				selectedFrozen,
				ctx.session.accountsViewExpanded ?? false
			)
		})
	})
}
