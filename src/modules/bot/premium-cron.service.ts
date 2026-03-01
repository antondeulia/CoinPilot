import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { InlineKeyboard } from 'grammy'
import { SubscriptionService } from '../subscription/subscription.service'
import { BotService } from './bot.service'
import { StripeService } from '../stripe/stripe.service'

@Injectable()
export class PremiumCronService {
	private readonly logger = new Logger(PremiumCronService.name)

	constructor(
		private readonly subscriptionService: SubscriptionService,
		private readonly botService: BotService,
		private readonly stripeService: StripeService
	) {}

	private readonly day3Marker = 'trial_day3_channel_v1'
	private readonly day5Marker = 'trial_day5_yearly_v1'
	private readonly day7Marker = 'trial_day7_expired_v1'

	private readonly day3Text =
		'Я вижу, ты уже третий день ведешь учет. Отличная динамика. Пока ты фиксируешь крупные транзакции, биржи продолжают тихо списывать твои деньги на скрытых комиссиях и невыгодных спредах. Сегодня в своем личном канале я разобрал конкретную механику, которая съедает до двух процентов от каждого твоего депозита при переводах. Я показал способ это обойти. Ссылка на разбор находится ниже. Изучи материал, чтобы не кормить чужой бизнес.'

	private readonly day5Text =
		'Через два дня твой бесплатный Pro доступ закончится. Базовая подписка стоит 3.99 евро в месяц. За год это почти 48 евро. Системный подход к финансам подразумевает жесткую оптимизацию издержек. Поэтому я даю тебе окно возможностей. Оплати сразу год использования бота за 29.99 евро. Твоя цена составит 2.49 евро в месяц. Ты экономишь почти 40 процентов и закрываешь вопрос контроля капитала на ближайшие 12 месяцев. Кнопка ниже ведет на безопасную оплату через Stripe. Сделай грамотный финансовый ход.'

	private readonly day7Text =
		'⏳ Твой Trial-период завершён. Чтобы сохранить полный контроль над капиталом, активируй Pro за 3.99 EUR в месяц.'

	private getErrorCode(error: unknown): string {
		return String((error as any)?.code ?? 'unknown')
	}

	private async runCronSafe(task: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn()
		} catch (error: unknown) {
			this.logger.warn(
				`${task} skipped for current tick (errorCode=${this.getErrorCode(error)}): ${
					(error as Error)?.message ?? error
				}`
			)
		}
	}

	@Cron('0 * * * *')
	async checkExpiredSubscriptions() {
		await this.runCronSafe('checkExpiredSubscriptions', async () => {
			const expired = await this.subscriptionService.checkAndExpirePremium()
			for (const u of expired) {
				if (!u.expiredTrial) {
					await this.botService.sendToUser(
						u.telegramId,
						'💠 Ваш Pro-тариф истёк. Продолжайте пользоваться безлимитом — оформите подписку снова в меню Подписки.'
					)
					continue
				}
				const marked = await this.subscriptionService.markMarkerIfAbsent(
					u.userId,
					this.day7Marker
				)
				if (!marked) continue
				try {
					const monthlyUrl = await this.stripeService.createCheckoutSession({
						userId: u.userId,
						telegramId: u.telegramId,
						plan: 'monthly'
					})
					await this.botService.sendToUser(u.telegramId, this.day7Text, {
						reply_markup: new InlineKeyboard().url(
							'Оплатить 3.99 EUR / месяц',
							monthlyUrl
						)
					})
				} catch (error) {
					this.logger.warn(
						`trial day7 monthly CTA failed for user=${u.userId}: ${(error as Error)?.message ?? error}`
					)
					await this.botService.sendToUser(u.telegramId, this.day7Text)
				}
			}
		})
	}

	@Cron('*/30 * * * *')
	async runTrialFunnel() {
		await this.runCronSafe('runTrialFunnel', async () => {
			const users = await this.subscriptionService.getActiveTrialUsersForFunnel()
			const nowMs = Date.now()
			const dayMs = 24 * 60 * 60 * 1000
			for (const u of users) {
				const elapsedMs = nowMs - u.startDate.getTime()
				if (elapsedMs >= 3 * dayMs && elapsedMs < 5 * dayMs) {
					const markedDay3 = await this.subscriptionService.markMarkerIfAbsent(
						u.userId,
						this.day3Marker
					)
					if (markedDay3) {
						await this.botService.sendToUser(u.telegramId, this.day3Text, {
							reply_markup: new InlineKeyboard().url(
								'Читать разбор в канале',
								'https://t.me/+wgGgRr_Kf6BhMjgy'
							)
						})
					}
				}

				if (elapsedMs >= 5 * dayMs && elapsedMs < 7 * dayMs) {
					const markedDay5 = await this.subscriptionService.markMarkerIfAbsent(
						u.userId,
						this.day5Marker
					)
					if (!markedDay5) continue
					try {
						const yearlyUrl = await this.stripeService.createCheckoutSession({
							userId: u.userId,
							telegramId: u.telegramId,
							plan: 'yearly'
						})
						await this.botService.sendToUser(u.telegramId, this.day5Text, {
							reply_markup: new InlineKeyboard().url(
								'Оплатить год за 29.99 EUR',
								yearlyUrl
							)
						})
					} catch (error) {
						this.logger.warn(
							`trial day5 yearly CTA failed for user=${u.userId}: ${(error as Error)?.message ?? error}`
						)
						await this.botService.sendToUser(u.telegramId, this.day5Text)
					}
				}
			}
		})
	}
}
