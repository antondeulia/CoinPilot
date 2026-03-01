import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { PremiumEventType } from '../../../generated/prisma/enums'
import { StripeService } from '../../../modules/stripe/stripe.service'

const STRIPE_PORTAL_FALLBACK_URL = 'https://billing.stripe.com/p/login/00w7sL0zi10vc3oa2y6EU00'

const PREMIUM_PAGE_TEXT = `💠 Подписка

Вы используете Basic-план.
Некоторые возможности ограничены.

<b>🆓 Ваш текущий тариф — Basic</b>

<blockquote>• До 30 транзакций в месяц
• До 2 счетов
• Аналитика до 30 дней
• Ограниченные категории и теги</blockquote>

<b>🚀 Что открывает Pro</b>

<blockquote>• Безлимитные транзакции и счета
• Полная аналитика капитала
• Экспорт CSV
• Свои категории и теги
• Будущие Pro-инструменты <i>(ИИ-агент, бюджеты, цели...)</i></blockquote>

Начните сейчас и управляйте капиталом без ограничений.`

function premiumKeyboard(fromUpsell: boolean) {
	const kb = new InlineKeyboard()
	kb
		.text('🚀 Ежемесячный доступ — 3,99 €', 'premium_buy_monthly')
		.row()
		.text('🔥 Годовой доступ — 29,99 € (экономия 38%)', 'premium_buy_yearly')
		.row()
		.text(fromUpsell ? 'Закрыть' : '← Назад', fromUpsell ? 'hide_message' : 'go_home')
	return kb
}

function formatSubscriptionMessage(d: {
	active: boolean
	plan: string
	planName: string
	endDate: Date | null
	daysLeft: number | null
	amount: number
	currency: string
	periodLabel: string
	isTrial: boolean
	autoRenew: boolean | null
}): string {
	if (!d.active) {
		return `💠 Подписка

Вы используете Basic-план.
Некоторые возможности ограничены.`
	}
	const endStr = d.endDate
		? d.endDate.toLocaleDateString('ru-RU')
		: '—'
	const typeLine =
		d.plan === 'monthly'
			? '📅 Тип: Месячная'
			: d.plan === 'yearly'
				? '🗓️ Тип: Годовая'
				: d.plan === 'trial'
					? '🎁 Тип: Trial'
					: `💼 Тип: ${d.planName}`
	const trialExpiryLine =
		d.isTrial && d.endDate
			? `\n⏳ Срок истекает: ${endStr} (${Math.max(d.daysLeft ?? 0, 0)} дн.)`
			: ''
	return `💠 Подписка

🟢 Статус: Активна
💼 Тариф: Pro
${typeLine}${trialExpiryLine}`
// 📅 Следующее списание: ${endStr}
}

export const premiumCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService,
	stripeService: StripeService
) => {
	bot.callbackQuery('view_subscription', async ctx => {
		const user = ctx.state.user as any
		if (!user?.id) return
		const d = await subscriptionService.getSubscriptionDisplay(user.id)
		const text = formatSubscriptionMessage(d)
		const kb = new InlineKeyboard()
		if (d.active) {
			kb.text('⚙️ Управление подпиской', 'subscription_manage').row()
		} else {
			kb.text('Оформить подписку', 'view_premium').row()
		}
		kb.text('← Назад', 'back_to_settings')
		try {
			await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
		} catch {
			await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
		}
		await ctx.answerCallbackQuery()
	})

	bot.callbackQuery('subscription_manage', async ctx => {
		const user = ctx.state.user as any
		if (!user?.id) return
		let url = await stripeService.createBillingPortalSession(user.id)
		if (!url) url = STRIPE_PORTAL_FALLBACK_URL
		await ctx.answerCallbackQuery()
		await ctx.reply('Откройте ссылку для управления подпиской:', {
			reply_markup: new InlineKeyboard().url('⚙️ Управление подпиской', url)
		})
	})

	bot.command('subscription', async ctx => {
		const user = ctx.state.user as any
		if (!user?.id) return
		const d = await subscriptionService.getSubscriptionDisplay(user.id)
		const text = formatSubscriptionMessage(d)
		const kb = new InlineKeyboard()
		if (d.active) {
			kb.text('⚙️ Изменить подписку', 'subscription_manage').row()
		} else {
			kb.text('Оформить подписку', 'view_premium').row()
		}
		kb.text('Закрыть', 'hide_message')
		await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
	})

	bot.callbackQuery('view_premium', async ctx => {
		const user = ctx.state.user as any
		await subscriptionService.trackEvent(user.id, PremiumEventType.premium_page_view)
		const fromUpsell =
			ctx.callbackQuery?.message?.message_id !== ctx.session.homeMessageId
		if (ctx.state.isPremium) {
			const kb = new InlineKeyboard().text(
				fromUpsell ? 'Закрыть' : '← Назад',
				fromUpsell ? 'hide_message' : 'go_home'
			)
			try {
				await ctx.editMessageText('💠 У вас уже активен Pro-тариф. Спасибо!', {
					reply_markup: kb
				})
			} catch {
				await ctx.reply('💠 У вас уже активен Pro-тариф. Спасибо!', {
					reply_markup: kb
				})
			}
			return
		}
		const fromSettings =
			ctx.callbackQuery?.message?.message_id === ctx.session.homeMessageId
		const text = PREMIUM_PAGE_TEXT
			const kb = fromSettings
				? new InlineKeyboard()
						.text(
							'🚀 Ежемесячный доступ — 3,99 €',
							'premium_buy_monthly'
						)
						.row()
						.text(
							'🔥 Годовой доступ — 29,99 € (экономия 38%)',
							'premium_buy_yearly'
						)
					.row()
					.text('← Назад', 'back_to_settings')
			: premiumKeyboard(fromUpsell)
		try {
			await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb })
		} catch {
			await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
		}
	})

	bot.callbackQuery('premium_buy_monthly', async ctx => {
		const user = ctx.state.user as any
		const telegramId = String(ctx.from?.id ?? user.telegramId)
		try {
			const url = await stripeService.createCheckoutSession({
				userId: user.id,
				telegramId,
				plan: 'monthly'
			})
			await ctx.reply('Оплата Pro — 1 месяц:', {
				reply_markup: new InlineKeyboard().url('Оплатить 3,99 €', url)
			})
			await ctx.answerCallbackQuery()
		} catch (e) {
			await ctx.answerCallbackQuery({
				text: 'Оплата временно недоступна, свяжитесь с поддержкой @coinpilot_helper.'
			})
		}
	})

	bot.callbackQuery('premium_buy_yearly', async ctx => {
		const user = ctx.state.user as any
		const telegramId = String(ctx.from?.id ?? user.telegramId)
		try {
			const url = await stripeService.createCheckoutSession({
				userId: user.id,
				telegramId,
				plan: 'yearly'
			})
			await ctx.reply('Оплата Pro — 1 год:', {
				reply_markup: new InlineKeyboard().url('Оплатить 29,99 €', url)
			})
			await ctx.answerCallbackQuery()
		} catch (e) {
			await ctx.answerCallbackQuery({
				text: 'Оплата временно недоступна, свяжитесь с поддержкой @coinpilot_helper.'
			})
		}
	})
}
