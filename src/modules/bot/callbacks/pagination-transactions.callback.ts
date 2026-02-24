import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

async function updatePreview(ctx: BotContext, accountsService: AccountsService) {
	const drafts = ctx.session.draftTransactions
	const index = ctx.session.currentTransactionIndex ?? 0

	if (!drafts || !drafts.length || ctx.session.tempMessageId == null) {
		return
	}

	const current = drafts[index] as any
	const user = ctx.state.user as any
	const accountId =
		current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
	const showConversion = await getShowConversion(
		current,
		accountId ?? null,
		ctx.state.user.id,
		accountsService
	)

	try {
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.tempMessageId,
			renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
			{
				parse_mode: 'HTML',
				reply_markup: confirmKeyboard(
					drafts.length,
					index,
					showConversion,
					current?.direction === 'transfer' && !current?.tradeType,
					!!ctx.session.editingTransactionId,
					current?.tradeType
				)
			}
		)
	} catch {}
}

export const paginationTransactionsCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	bot.callbackQuery('pagination_back_transactions', async ctx => {
		const drafts = ctx.session.draftTransactions
		if (!drafts || !drafts.length) return

		const total = drafts.length
		let index = ctx.session.currentTransactionIndex ?? 0
		index = index <= 0 ? total - 1 : index - 1
		ctx.session.currentTransactionIndex = index

		await updatePreview(ctx, accountsService)
	})

	bot.callbackQuery('pagination_forward_transactions', async ctx => {
		const drafts = ctx.session.draftTransactions
		if (!drafts || !drafts.length) return

		const total = drafts.length
		let index = ctx.session.currentTransactionIndex ?? 0
		index = index >= total - 1 ? 0 : index + 1
		ctx.session.currentTransactionIndex = index

		await updatePreview(ctx, accountsService)
	})

	bot.callbackQuery('pagination_preview_transactions', async () => {})
}
