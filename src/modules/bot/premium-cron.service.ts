import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { SubscriptionService } from '../subscription/subscription.service'
import { BotService } from './bot.service'

@Injectable()
export class PremiumCronService {
	constructor(
		private readonly subscriptionService: SubscriptionService,
		private readonly botService: BotService
	) {}

	@Cron('0 * * * *')
	async checkExpiredSubscriptions() {
		const expired = await this.subscriptionService.checkAndExpirePremium()
		for (const u of expired) {
			await this.botService.sendToUser(
				u.telegramId,
				'👑 Ваш Premium истёк. Продолжайте пользоваться безлимитом — оформите подписку снова в меню Premium.'
			)
		}
	}

	@Cron('0 10 1 * *')
	async monthlyUpsell() {
		const users = await this.subscriptionService.getUsersForMonthlyUpsell()
		const text =
			'👑 Специальное предложение: оформите Premium со скидкой и получите безлимитные счета, теги и экспорт. Нажмите Premium в меню.'
		for (const u of users) {
			await this.botService.sendToUser(u.telegramId, text)
		}
	}

	@Cron('0 10 1 1,4,7,10 *')
	async quarterlyLifetimeOffer() {
		const users = await this.subscriptionService.getUsersForQuarterlyLifetimeOffer()
		const text =
			'👑 Ограниченное предложение: Premium навсегда за 49,99 €. Одна оплата — безлимит навсегда. В меню: Premium.'
		for (const u of users) {
			await this.botService.sendToUser(u.telegramId, text)
		}
	}
}
