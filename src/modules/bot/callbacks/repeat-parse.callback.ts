import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { buildAddTransactionPrompt } from './add-transaction.command'
import { activateInputMode } from '../core/input-mode'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { AccountsService } from '../../../modules/accounts/accounts.service'

async function performRepeatParse(
	ctx: BotContext,
	subscriptionService: SubscriptionService,
	transactionsService: TransactionsService
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

	if (ctx.session.tempMessageId) {
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
		} catch {}
	}
	if (ctx.session.editMessageId) {
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
		} catch {}
	}

	activateInputMode(ctx, 'transaction_parse', {
		awaitingTransaction: true,
		confirmingTransaction: false,
		draftTransactions: undefined,
		currentTransactionIndex: undefined,
		autoCreatedTxIdsForCurrentParse: undefined
	})

	const text = await buildAddTransactionPrompt(ctx, subscriptionService)
	const msg = await ctx.reply(text, {
		parse_mode: 'HTML',
		reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
	})
	ctx.session.tempMessageId = msg.message_id
	ctx.session.repeatTxConfirmMessageId = undefined
}

export const repeatParseCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService,
	transactionsService: TransactionsService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('repeat_tx_confirm_open', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return
		ctx.session.repeatTxConfirmMessageId = ctx.session.tempMessageId
		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				'Повторить ввод и удалить текущий предпросмотр?',
				{
					reply_markup: new InlineKeyboard()
						.text('Да', 'repeat_tx_confirm_yes')
						.text('← Назад', 'repeat_tx_confirm_back')
				}
			)
		} catch {}
	})

	bot.callbackQuery('repeat_tx_confirm_yes', async ctx => {
		await performRepeatParse(ctx, subscriptionService, transactionsService)
	})

	bot.callbackQuery('repeat_tx_confirm_back', async ctx => {
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

	// Backward compatibility for old inline messages.
	bot.callbackQuery('repeat_parse', async ctx => {
		await performRepeatParse(ctx, subscriptionService, transactionsService)
	})
}

