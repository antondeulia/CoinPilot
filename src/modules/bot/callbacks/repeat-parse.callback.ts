import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { buildAddTransactionPrompt } from './add-transaction.command'

export const repeatParseCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('repeat_parse', async ctx => {
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
		}

		ctx.session.awaitingTransaction = true
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined

		const text = await buildAddTransactionPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(text, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
		})

		ctx.session.tempMessageId = msg.message_id
	})
}
