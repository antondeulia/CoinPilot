import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { resetToHome } from '../utils/reset-home'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

export const cancelTxCallback = (
	bot: Bot<BotContext>,
	transactionsService: TransactionsService,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('ask_cancel_tx', async ctx => {
		if (ctx.session.tempMessageId == null) return
		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				'Удалить все операции из текущего предпросмотра?',
				{
					reply_markup: {
						inline_keyboard: [
							[
								{ text: 'Да', callback_data: 'cancel_tx_confirm_yes' },
								{ text: 'Нет', callback_data: 'cancel_tx_confirm_no' }
							]
						]
					}
				}
			)
		} catch {}
	})

	bot.callbackQuery('cancel_tx_confirm_no', async ctx => {
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
				renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
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

	bot.callbackQuery('cancel_tx_confirm_yes', async ctx => {
		await deleteAllPreview(ctx, transactionsService, accountsService, analyticsService)
	})

	bot.callbackQuery('cancel_tx', async ctx => {
		await deleteAllPreview(ctx, transactionsService, accountsService, analyticsService)
	})

	bot.callbackQuery('close_preview', async ctx => {
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		ctx.session.editingTransactionId = undefined
		ctx.session.autoCreatedTxIdsForCurrentParse = undefined
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
	})
}

async function deleteAllPreview(
	ctx: BotContext,
	transactionsService: TransactionsService,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
) {
	const drafts = ctx.session.draftTransactions ?? []
	const rollbackIds = new Set<string>([
		...(((ctx.session.autoCreatedTxIdsForCurrentParse ?? []) as string[]) || []),
		...(drafts as any[])
			.map(draft => String(draft?.id ?? '').trim())
			.filter(Boolean)
	])
	for (const txId of rollbackIds) {
		await transactionsService.delete(txId, ctx.state.user.id).catch(() => {})
	}
	ctx.session.confirmingTransaction = false
	ctx.session.draftTransactions = undefined
	ctx.session.currentTransactionIndex = undefined
	ctx.session.autoCreatedTxIdsForCurrentParse = undefined

	if (ctx.session.tempMessageId) {
		try {
			await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
		} catch {}
		ctx.session.tempMessageId = undefined
	}

	await resetToHome(ctx, accountsService, analyticsService)
}
