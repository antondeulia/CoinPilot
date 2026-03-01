import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { activateInputMode } from '../core/input-mode'

export async function buildAddAccountPrompt(
	ctx: BotContext,
	subscriptionService: SubscriptionService
): Promise<string> {
	if (ctx.state.isPremium) {
		return `➕ <b>Добавление счёта</b>

Введите данные одним из способов:
<blockquote>• текстом
• голосовым сообщением
• фото/скриншотом</blockquote>

<i>Если вы не укажете счёт, транзакция будет создана для основного счёта. Основной счёт может изменить в настройках. После создания транзакции счёт можно изменить.</i>

<code>🧠 AI-распознавание активировано.</code>`
	}
	const limit = await subscriptionService.canCreateAccount(ctx.state.user.id)
	return `➕ <b>Добавление счёта</b>

Введите данные одним из способов:
<blockquote>• текстом
• голосовым сообщением
• фото/скриншотом</blockquote>

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
				'💠 Вы достигли лимита — 2 счета в Basic. Перейдите на Pro-тариф и управляйте финансами без ограничений!',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
			activateInputMode(ctx, 'account_parse', {
				awaitingAccountInput: true,
				confirmingAccounts: false,
			draftAccounts: undefined,
			currentAccountIndex: undefined
		})

		const prompt = await buildAddAccountPrompt(ctx, subscriptionService)
		const msg = await ctx.reply(prompt, {
			parse_mode: 'HTML',
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_account')
		})

			;(ctx.session as any).accountInputHintMessageId = msg.message_id
			ctx.session.hintMessageId = msg.message_id
			ctx.session.tempMessageId = undefined
		})
}
