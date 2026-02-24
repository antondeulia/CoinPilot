import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { buildAddTransactionPrompt } from './add-transaction.command'

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

		ctx.session.awaitingTransaction = true
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		ctx.session.awaitingAccountInput = false
		ctx.session.awaitingTagsJarvisEdit = false
		ctx.session.awaitingCategoryName = false
		ctx.session.editingTimezone = false
		ctx.session.editingAccountField = undefined
		ctx.session.awaitingTagInput = false
		ctx.session.editingField = undefined
		ctx.session.editMessageId = undefined
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingCurrency = false
		;(ctx.session as any).editingTransactionId = undefined

		const text = await buildAddTransactionPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(text, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
		})

		ctx.session.tempMessageId = msg.message_id
	})
}
