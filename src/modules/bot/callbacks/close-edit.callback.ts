import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

export const closeEditCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	bot.callbackQuery('close_edit', async ctx => {
		if (ctx.callbackQuery.message) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.callbackQuery.message.message_id
				)
			} catch {}
		}

		ctx.session.editingField = undefined
		ctx.session.editMessageId = undefined
		ctx.session.accountsPage = undefined
		ctx.session.categoriesPage = undefined
		ctx.session.pendingTransferSide = undefined
	})

	bot.callbackQuery('close_add_account', async ctx => {
		if (ctx.callbackQuery.message) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.callbackQuery.message.message_id
				)
			} catch {}
		}

		ctx.session.awaitingAccountInput = undefined
	})

	bot.callbackQuery('close_edit_account', async ctx => {
		if (ctx.callbackQuery.message) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.callbackQuery.message.message_id
				)
			} catch {}
		}

		ctx.session.editingAccountField = undefined
		ctx.session.editMessageId = undefined
	})

	bot.callbackQuery('close_jarvis_details_edit', async ctx => {
		if (ctx.callbackQuery.message) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.callbackQuery.message.message_id
				)
			} catch {}
		}
		ctx.session.editingAccountDetailsId = undefined
		ctx.session.editMessageId = undefined
	})

	bot.callbackQuery('back_to_preview', async ctx => {
		;(ctx.session as any).editingCurrency = false
		ctx.session.editingField = undefined
		ctx.session.awaitingTagInput = false
		ctx.session.tagsPage = undefined
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

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
				renderConfirmMessage(
					current,
					index,
					drafts.length,
					user.defaultAccountId
				),
				{
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard(
						drafts.length,
						index,
						showConversion,
						current?.direction === 'transfer',
						!!ctx.session.editingTransactionId
					)
				}
			)
		} catch {}
	})
}
