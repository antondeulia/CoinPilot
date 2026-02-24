import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'

async function buildAddAccountPrompt(
	ctx: BotContext,
	subscriptionService: SubscriptionService
): Promise<string> {
	if (ctx.state.isPremium) {
		return `➕ <b>Добавление счёта</b>

Введите данные одним из способов:
<blockquote>• текстом
• голосовым сообщением</blockquote>

<code>🧠 AI-распознавание активировано.</code>`
	}
	const limit = await subscriptionService.canCreateAccount(ctx.state.user.id)
	return `➕ <b>Добавление счёта</b>

Введите данные одним из способов:
<blockquote>• текстом
• голосовым сообщением</blockquote>

— — —

📊 Лимиты тарифа Basic:
Счета: <i>${limit.current}/${limit.limit}</i>.

💠 В Pro-тарифе лимиты отсутствуют.`
}

export const addAccountCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('add_account', async ctx => {
		const limit = await subscriptionService.canCreateAccount(ctx.state.user.id)
		if (!limit.allowed) {
			await ctx.reply(
				'💠 Вы достигли лимита — 2 счета в Free. Перейдите на Premium и управляйте финансами без ограничений!',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		ctx.session.awaitingAccountInput = true
		ctx.session.confirmingAccounts = false
		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.awaitingTransaction = false
		ctx.session.confirmingTransaction = false
		ctx.session.editingField = undefined
		ctx.session.editingTimezone = false
		ctx.session.awaitingTagsJarvisEdit = false
		ctx.session.awaitingCategoryName = false
		ctx.session.awaitingTagInput = false
		ctx.session.editingAccountField = undefined
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingCurrency = false

		const prompt = await buildAddAccountPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(prompt, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_account')
		})

		;(ctx.session as any).accountInputHintMessageId = msg.message_id
		ctx.session.tempMessageId = undefined
	})
}
