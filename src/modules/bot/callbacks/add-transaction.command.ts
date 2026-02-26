import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { activateInputMode, resetInputModes } from '../core/input-mode'

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

<i>Если вы не укажете счёт, транзакция будет создана для основного счёта. Основной счёт может изменить в настройках. После создания транзакции счёт можно изменить.</i>

<code>🧠 AI-распознавание активировано.</code>`
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

📊 Лимиты тарифа Basic в текущем месяце:
Операции: <i>${txLimit.current}/${txLimit.limit}</i>
Фото-распознавание: <i>${imageLimit.current}/${imageLimit.limit}</i>

	${footer}`
}

export async function openAddTransactionFlow(
	ctx: BotContext,
	subscriptionService: SubscriptionService
) {
	const visibleAccounts = (ctx.state.user.accounts ?? []).filter(
		(a: { isHidden?: boolean }) => !a.isHidden
	)
	if (visibleAccounts.length === 0) {
		await ctx.reply(
			'Нельзя создать операцию: у вас нет счётов. Добавьте счёт во вкладке «Счета».',
			{
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			}
		)
		return
	}
	const txLimit = await subscriptionService.canCreateTransaction(ctx.state.user.id)
	if (!txLimit.allowed) {
		await ctx.reply(
			'💠 30 транзакций в месяц — лимит Basic. Разблокируйте безлимит с Pro-тарифом!',
			{
				reply_markup: new InlineKeyboard()
					.text('💠 Pro-тариф', 'view_premium')
					.row()
					.text('Закрыть', 'hide_message')
			}
		)
		return
	}
	if (ctx.session.tempMessageId) {
		const tempMessageId = ctx.session.tempMessageId
		const keep = new Set<number>((ctx.session.resultMessageIds ?? []) as number[])
		const canDeleteTemp =
			!keep.has(tempMessageId) && tempMessageId !== ctx.session.previewMessageId
		if (!canDeleteTemp) {
			ctx.session.tempMessageId = undefined
		}
		if (canDeleteTemp) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, tempMessageId)
			} catch {}
		}
	}
	;(ctx.session as any).editingCurrency = false
	;(ctx.session as any).editingMainCurrency = false
	ctx.session.editingField = undefined
	activateInputMode(ctx, 'transaction_parse', { awaitingTransaction: true })

	const text = await buildAddTransactionPrompt(ctx, subscriptionService)
	const msg = await ctx.reply(text, {
		parse_mode: 'HTML',
		reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_transaction')
	})

	ctx.session.tempMessageId = msg.message_id
	ctx.session.hintMessageId = msg.message_id
}

export const addTxCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('add_transaction', async ctx => {
		await openAddTransactionFlow(ctx, subscriptionService)
	})

	bot.callbackQuery('close_add_transaction', async ctx => {
		resetInputModes(ctx)

		try {
			await ctx.api.deleteMessage(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id
			)
		} catch {}

		ctx.session.tempMessageId = undefined
	})
}
