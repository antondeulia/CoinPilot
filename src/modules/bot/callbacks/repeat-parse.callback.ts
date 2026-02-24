import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { buildAddTransactionPrompt } from './add-transaction.command'
import { activateInputMode } from '../core/input-mode'

export const repeatParseCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService,
	transactionsService: TransactionsService
) => {
	bot.callbackQuery('repeat_parse', async ctx => {
		const drafts = ctx.session.draftTransactions ?? []
		for (const draft of drafts as any[]) {
			if (draft?.id) {
				await transactionsService.delete(draft.id, ctx.state.user.id).catch(() => {})
			}
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
			currentTransactionIndex: undefined
		})

		const text = await buildAddTransactionPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(text, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
		})

		ctx.session.tempMessageId = msg.message_id
	})
}
