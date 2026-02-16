import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'

export async function buildAddTransactionPrompt(
	ctx: BotContext,
	subscriptionService: SubscriptionService
): Promise<string> {
	const isPremium = !!ctx.state.isPremium
	if (isPremium) {
		return `➕ <b>Добавление операции</b>

Введите данные одним из способов:
<blockquote>• текстом (пример: "Продукты 25 €")
• голосовым сообщением
• фото чека или скриншот операции</blockquote>

🧠 AI-распознавание активировано.`
	}
	const [txLimit, imageLimit] = await Promise.all([
		subscriptionService.canCreateTransaction(ctx.state.user.id),
		subscriptionService.canParseImage(ctx.state.user.id)
	])
	const nearLimit = txLimit.limit - txLimit.current <= 5
	const footer = nearLimit
		? `⚠ Почти достигнут лимит тарифа Basic.
Pro-тариф снимает ограничения.`
		: '💠 В Pro-тарифе лимиты отсутствуют.'
	return `➕ <b>Добавление операции</b>

Введите данные одним из способов:
<blockquote>• текстом
• голосовым сообщением
• фото чека или скриншот операции</blockquote>

— — —

📊 Лимиты тарифа Basic:
Операции: <i>${txLimit.current}/${txLimit.limit}</i>
Фото-распознавание: <i>${imageLimit.current}/${imageLimit.limit}</i>

${footer}`
}

export const addTxCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('add_transaction', async ctx => {
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
			} catch {}
		}
		;(ctx.session as any).editingCurrency = false
		;(ctx.session as any).editingMainCurrency = false
		ctx.session.editingField = undefined
		ctx.session.awaitingTransaction = true

		const text = await buildAddTransactionPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(text, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
		})

		ctx.session.tempMessageId = msg.message_id
	})

	bot.callbackQuery('close_add_transaction', async ctx => {
		ctx.session.awaitingTransaction = false

		try {
			await ctx.api.deleteMessage(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id
			)
		} catch {}

		ctx.session.tempMessageId = undefined
	})
}
