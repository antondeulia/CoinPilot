import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'

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
	subscriptionService: SubscriptionService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('add_transaction', async ctx => {
		const txLimit = await subscriptionService.canCreateTransaction(ctx.state.user.id)
		if (!txLimit.allowed) {
			await ctx.reply(
				'💠 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		const allAccounts = await accountsService.getAllByUserIdIncludingHidden(
			ctx.state.user.id
		)
		const realAccounts = allAccounts.filter(
			a => !a.isHidden && a.name !== 'Вне Wallet'
		)
		if (!realAccounts.length) {
			await ctx.reply('Сначала добавьте счёт во вкладке «Счета», затем создайте транзакцию.', {
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			})
			return
		}
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat.id, ctx.session.tempMessageId)
			} catch {}
		}
		;(ctx.session as any).editingCurrency = false
		;(ctx.session as any).editingMainCurrency = false
		ctx.session.editingTimezone = false
		ctx.session.awaitingTagsJarvisEdit = false
		ctx.session.awaitingCategoryName = false
		ctx.session.awaitingAccountInput = false
		ctx.session.awaitingTagInput = false
		ctx.session.editingAccountField = undefined
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingCurrency = false
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
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
