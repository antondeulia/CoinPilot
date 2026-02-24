import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Stripe from 'stripe'
import { PrismaService } from '../prisma/prisma.service'
import { SubscriptionPlan } from '../../generated/prisma/enums'
import { addDays } from '../subscription/subscription.service'

@Injectable()
export class StripeService {
	private readonly logger = new Logger(StripeService.name)
	private readonly stripe: Stripe
	private readonly webhookSecret: string

	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService
	) {
		const secret = this.config.getOrThrow<string>('STRIPE_SECRET_KEY')
		this.webhookSecret =
			this.config.get<string>('STRIPE_WEBHOOK_SECRET') ??
			this.config.getOrThrow<string>('WEBHOOK_SIGNING_SECRET')
		this.stripe = new Stripe(secret, {
			// использовать версию по умолчанию из пакета
		} as any)
	}

	/**
	 * Создать Checkout Session для подписки (monthly/yearly).
	 * Возвращает URL, по которому нужно отправить пользователя.
	 */
	async createCheckoutSession(params: {
		userId: string
		telegramId: string
		plan: 'monthly' | 'yearly'
	}): Promise<string> {
		const priceId =
			params.plan === 'monthly'
				? this.config.getOrThrow<string>('STRIPE_PRICE_MONTHLY')
				: this.config.getOrThrow<string>('STRIPE_PRICE_YEARLY')

		const successUrl =
			this.config.get<string>('STRIPE_SUCCESS_URL') ??
			'https://t.me/isi_crypto'
		const cancelUrl =
			this.config.get<string>('STRIPE_CANCEL_URL') ?? successUrl

		const user = await this.prisma.user.findUnique({
			where: { id: params.userId },
			select: { trialUsed: true, stripeCustomerId: true, telegramId: true }
		})
		const ledger = await this.prisma.trialLedger.findUnique({
			where: { telegramId: params.telegramId },
			select: { id: true }
		})
		const subscriptionData: { metadata: { user_id: string; plan: string }; trial_period_days?: number } = {
			metadata: {
				user_id: params.userId,
				plan: params.plan
			}
		}
		const canUseTrial = !!user && !user.trialUsed && !ledger
		if (canUseTrial) {
			subscriptionData.trial_period_days = 7
		}
		const session = await this.stripe.checkout.sessions.create({
			mode: 'subscription',
			line_items: [
				{
					price: priceId,
					quantity: 1
				}
			],
			success_url: successUrl,
			cancel_url: cancelUrl,
			client_reference_id: params.telegramId,
			metadata: {
				user_id: params.userId,
				plan: params.plan,
				telegram_id: params.telegramId
			},
			subscription_data: subscriptionData,
			...(user?.stripeCustomerId ? { customer: user.stripeCustomerId } : {})
		})

		if (!session.url) {
			throw new Error('Stripe session has no URL')
		}
		return session.url
	}

	async createBillingPortalSession(userId: string): Promise<string | null> {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { stripeCustomerId: true }
		})
		if (!user?.stripeCustomerId) return null
		const returnUrl =
			this.config.get<string>('STRIPE_SUCCESS_URL') ??
			this.config.get<string>('STRIPE_CANCEL_URL') ??
			'https://t.me'
		const session = await this.stripe.billingPortal.sessions.create({
			customer: user.stripeCustomerId,
			return_url: returnUrl
		})
		return session.url
	}

	/**
	 * Обработка webhook’ов Stripe.
	 * Ожидает, что в metadata есть user_id и plan ('monthly' | 'yearly').
	 */
	async handleWebhook(payload: Buffer, signature: string | undefined) {
		if (!signature) {
			this.logger.warn('Missing Stripe signature header')
			return
		}

		let event: Stripe.Event
		try {
			event = this.stripe.webhooks.constructEvent(
				payload,
				signature,
				this.webhookSecret
			)
		} catch (err) {
			this.logger.error('Stripe webhook signature verification failed', err as any)
			return
		}

		switch (event.type) {
			case 'checkout.session.completed':
				await this.handleCheckoutCompleted(
					event.data.object as Stripe.Checkout.Session
				)
				break
			case 'invoice.paid':
				await this.handleInvoicePaid(event.data.object as Stripe.Invoice)
				break
			case 'customer.subscription.updated':
				await this.handleSubscriptionUpdated(
					event.data.object as Stripe.Subscription
				)
				break
			case 'customer.subscription.deleted':
				await this.handleSubscriptionDeleted(
					event.data.object as Stripe.Subscription
				)
				break
			default:
				// игнорируем остальные события
				break
		}
	}

	private async handleCheckoutCompleted(session: any) {
		const metadata = session.metadata ?? {}
		const userId = metadata.user_id
		const planMeta = metadata.plan as 'monthly' | 'yearly' | undefined
		if (!userId || !planMeta) {
			this.logger.warn(
				`checkout.session.completed без user_id/plan в metadata, id=${session.id}`
			)
			return
		}

		const stripeSubId = session.subscription as string | null
		if (!stripeSubId) {
			this.logger.warn(`checkout.session.completed без subscription id`)
			return
		}

		let stripeSub: any
		try {
			stripeSub = await this.stripe.subscriptions.retrieve(stripeSubId)
		} catch (e) {
			this.logger.error('Не удалось получить Stripe subscription', e as any)
			return
		}

		let end: Date | null = null
		if (stripeSub.current_period_end) {
			end = new Date(stripeSub.current_period_end * 1000)
		}
		if (stripeSub.status === 'trialing') {
			end = addDays(new Date(), 7)
		}
		const plan =
			planMeta === 'monthly'
				? SubscriptionPlan.monthly
				: SubscriptionPlan.yearly

		const stripeCustomerId = session.customer as string | null

		await this.prisma.$transaction([
			this.prisma.user.update({
				where: { id: userId },
				data: {
					isPremium: true,
					premiumUntil: end,
					trialUsed: true,
					...(stripeCustomerId && { stripeCustomerId })
				}
			}),
			this.prisma.subscription.create({
				data: {
					userId,
					plan,
					status: 'active',
					startDate: new Date(),
					endDate: end,
					amount: (session.amount_total ?? 0) / 100,
					currency: (session.currency ?? 'eur').toUpperCase()
				}
			})
		])

		if (stripeSub.status === 'trialing') {
			const user = await this.prisma.user.findUnique({
				where: { id: userId },
				select: { telegramId: true }
			})
			const telegramId = String(metadata.telegram_id ?? user?.telegramId ?? '').trim()
			if (telegramId) {
				await this.prisma.trialLedger.upsert({
					where: { telegramId },
					update: {
						firstUserId: userId,
						...(stripeCustomerId ? { stripeCustomerId } : {}),
						usedAt: new Date()
					},
					create: {
						telegramId,
						firstUserId: userId,
						stripeCustomerId: stripeCustomerId ?? null
					}
				})
			}
		}
	}
	private async handleInvoicePaid(invoice: any) {
		const subId = invoice.subscription as string | null
		if (!subId) return

		let stripeSub: any
		try {
			stripeSub = await this.stripe.subscriptions.retrieve(subId)
		} catch (e) {
			this.logger.error('Не удалось получить Stripe subscription (invoice)', e as any)
			return
		}

		const meta = stripeSub.metadata ?? {}
		const userId = meta.user_id
		if (!userId) return

let end: Date | null = null;
if (stripeSub.current_period_end) {

	 end = new Date(stripeSub.current_period_end * 1000)
}

		await this.prisma.$transaction([
			this.prisma.user.update({
				where: { id: userId },
				data: {
					isPremium: true,
					premiumUntil: end
				}
			}),
			this.prisma.subscription.updateMany({
				where: { userId, status: 'active' },
				data: { endDate: end }
			})
		])
	}

	private async handleSubscriptionUpdated(stripeSub: any) {
		const meta = stripeSub.metadata ?? {}
		const userId = meta.user_id
		if (!userId) return

let end: Date | null = null;
if (stripeSub.current_period_end) {

	 end = new Date(stripeSub.current_period_end * 1000)
}
		const status = stripeSub.status

		const isActive = status === 'active' || status === 'trialing'

		await this.prisma.$transaction([
			this.prisma.subscription.updateMany({
				where: { userId, status: 'active' },
				data: {
					endDate: end,
					status: isActive ? 'active' : 'expired'
				}
			}),
			this.prisma.user.update({
				where: { id: userId },
				data: {
					isPremium: isActive,
					premiumUntil: isActive ? end : null
				}
			})
		])
	}

	private async handleSubscriptionDeleted(stripeSub: any) {
		const meta = stripeSub.metadata ?? {}
		const userId = meta.user_id
		if (!userId) return
		await this.prisma.$transaction([
			this.prisma.subscription.updateMany({
				where: { userId, status: 'active' },
				data: { status: 'expired' }
			}),
			this.prisma.user.update({
				where: { id: userId },
				data: { isPremium: false, premiumUntil: null }
			})
		])
	}
}

