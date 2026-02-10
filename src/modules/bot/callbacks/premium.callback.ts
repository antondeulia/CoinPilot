import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { PremiumEventType } from '../../../generated/prisma/enums'

const STRIPE_MONTHLY_URL =
	'https://buy.stripe.com/00w7sL0zi10vc3oa2y6EU00'
const STRIPE_YEARLY_URL =
	'https://buy.stripe.com/aFa6oH81KaB56J47Uq6EU01'

const PREMIUM_PAGE_TEXT = `👑 CoinPilot Premium

🆓 Free:
• До 30 транзакций в месяц
• До 1 фото-запроса в месяц
• До 2 счетов и 10 валют на счёт
• Только дефолтные категории (без кастомных)
• До 3 кастомных тегов
• Аналитика за 7 и 30 дней

👑 Premium:
• Безлимитные транзакции и фото (в пределах системы)
• Безлимитные счета и валюты
• Безлимитные кастомные категории и теги
• Расширенная аналитика и периоды >30 дней
• Экспорт CSV/Excel и будущие Premium-фичи (повторения, семья, цели, API)`

function premiumKeyboard(showTrial: boolean) {
	const kb = new InlineKeyboard()
	kb
		.url('Оплатить 4,99 €/мес', STRIPE_MONTHLY_URL)
		.row()
		.url('Оплатить 39,99 €/год', STRIPE_YEARLY_URL)
		.row()
	if (showTrial) {
		kb.text('🎁 Попробовать 7 дней бесплатно', 'premium_start_trial').row()
	}
	kb.text('← Назад', 'go_home')
	return kb
}

export const premiumCallback = (
	bot: Bot<BotContext>,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('view_premium', async ctx => {
		const user = ctx.state.user as any
		await subscriptionService.trackEvent(user.id, PremiumEventType.premium_page_view)
		const canTrial = await subscriptionService.canStartTrial(user.id)
		const showTrial = canTrial.allowed
		const text = ctx.state.isPremium
			? '👑 У вас уже активен Premium. Спасибо!'
			: PREMIUM_PAGE_TEXT
		const kb = ctx.state.isPremium ? new InlineKeyboard().text('← Назад', 'go_home') : premiumKeyboard(showTrial)
		try {
			await ctx.editMessageText(text, { reply_markup: kb })
		} catch {
			await ctx.reply(text, { reply_markup: kb })
		}
	})

	bot.callbackQuery('premium_start_trial', async ctx => {
		const user = ctx.state.user as any
		const check = await subscriptionService.canStartTrial(user.id)
		if (!check.allowed) {
			const msg =
				check.reason === 'trial_used'
					? '👑 Пробный период уже был использован.'
					: check.reason === 'add_transaction_first'
						? 'Добавьте хотя бы одну транзакцию, затем попробуйте снова.'
						: 'Сейчас недоступно.'
			await ctx.answerCallbackQuery({ text: msg })
			return
		}
		await subscriptionService.startTrial(user.id)
		await ctx.answerCallbackQuery({
			text: '🎁 Premium на 7 дней активирован!'
		})
		try {
			await ctx.editMessageText(
				'👑 Premium Trial активирован на 7 дней. Наслаждайтесь безлимитом!',
				{ reply_markup: new InlineKeyboard().text('← Назад', 'go_home') }
			)
		} catch {
			await ctx.reply(
				'👑 Premium Trial активирован на 7 дней. Наслаждайтесь безлимитом!'
			)
		}
	})
}
