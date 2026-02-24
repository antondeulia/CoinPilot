import { Injectable } from '@nestjs/common'
import type { User } from '../../generated/prisma/client'
import { PremiumEventType, SubscriptionPlan } from '../../generated/prisma/enums'
import { PrismaService } from '../prisma/prisma.service'
import { FREE_LIMITS, TRIAL_DAYS } from './subscription.constants'
import { SYSTEM_MAX_CUSTOM_TAGS } from '../tags/tags.service'

export function addDays(date: Date, days: number): Date {
	const r = new Date(date)
	r.setDate(r.getDate() + days)
	return r
}

export interface LimitResult {
	allowed: boolean
	current: number
	limit: number
}

export interface FrozenItems {
	accountIdsOverLimit: string[]
	accountAssetCounts: Record<string, { current: number; limit: number }>
	customCategoryIdsOverLimit: string[]
	customTagIdsOverLimit: string[]
}

export interface InvoiceParams {
	title: string
	description: string
	payload: string
	currency: string
	prices: { label: string; amount: number }[]
}

const INVOICE_RATE_LIMIT_MS = 60_000
const FREE_TX_LIMIT_PER_MONTH = 30

@Injectable()
export class SubscriptionService {
	private readonly lastInvoiceAtByUser = new Map<string, number>()

	constructor(private readonly prisma: PrismaService) {}

	canSendInvoice(userId: string): boolean {
		const at = this.lastInvoiceAtByUser.get(userId)
		if (!at) return true
		return Date.now() - at >= INVOICE_RATE_LIMIT_MS
	}

	recordInvoiceSent(userId: string): void {
		this.lastInvoiceAtByUser.set(userId, Date.now())
	}

	isPremium(user: Pick<User, 'isPremium' | 'premiumUntil'>): boolean {
		if (!user.isPremium) return false
		if (user.premiumUntil == null) return true
		return user.premiumUntil > new Date()
	}

	async canCreateAccount(userId: string): Promise<LimitResult> {
		const isPrem = await this.isPremiumForUser(userId)
		const where = { userId, isHidden: false }
		if (isPrem) {
			const current = await this.prisma.account.count({ where })
			return { allowed: true, current, limit: FREE_LIMITS.MAX_ACCOUNTS }
		}
		const current = await this.prisma.account.count({ where })
		const limit = FREE_LIMITS.MAX_ACCOUNTS
		return { allowed: current < limit, current, limit }
	}

	async canCreateAsset(accountId: string): Promise<LimitResult> {
		const account = await this.prisma.account.findUnique({
			where: { id: accountId },
			select: { userId: true }
		})
		if (!account) return { allowed: false, current: 0, limit: FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT }
		const isPrem = await this.isPremiumForUser(account.userId)
		if (isPrem) {
			const current = await this.prisma.accountAsset.count({ where: { accountId } })
			return { allowed: true, current, limit: FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT }
		}
		const current = await this.prisma.accountAsset.count({ where: { accountId } })
		const limit = FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
		return { allowed: current < limit, current, limit }
	}

	async canCreateCategory(userId: string): Promise<LimitResult> {
		const isPrem = await this.isPremiumForUser(userId)
		if (isPrem) {
			const current = await this.prisma.category.count({
				where: { userId, isDefault: false }
			})
			return { allowed: true, current, limit: FREE_LIMITS.MAX_CUSTOM_CATEGORIES }
		}
		const current = await this.prisma.category.count({
			where: { userId, isDefault: false }
		})
		const limit = FREE_LIMITS.MAX_CUSTOM_CATEGORIES
		return { allowed: current < limit, current, limit }
	}

	async canCreateTag(userId: string): Promise<LimitResult> {
		const isPrem = await this.isPremiumForUser(userId)
		if (isPrem) {
			const current = await this.prisma.tag.count({
				where: { userId, isDefault: false }
			})
			return {
				allowed: current < SYSTEM_MAX_CUSTOM_TAGS,
				current,
				limit: SYSTEM_MAX_CUSTOM_TAGS
			}
		}
		const current = await this.prisma.tag.count({
			where: { userId, isDefault: false }
		})
		const limit = FREE_LIMITS.MAX_CUSTOM_TAGS
		return { allowed: current < limit, current, limit }
	}

	async canExport(userId: string): Promise<boolean> {
		const isPrem = await this.isPremiumForUser(userId)
		return isPrem ? true : FREE_LIMITS.EXPORT_ALLOWED
	}
	/**
	 * Лимит транзакций в месяц для Free.
	 */
	async canCreateTransaction(userId: string): Promise<LimitResult> {
		const isPrem = await this.isPremiumForUser(userId)
		const now = new Date()
		const startOfMonth = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
		)
		const current = await this.prisma.transaction.count({
			where: {
				userId,
				transactionDate: { gte: startOfMonth, lte: now }
			}
		})
		if (isPrem) {
			return { allowed: true, current, limit: FREE_TX_LIMIT_PER_MONTH }
		}
		const limit = FREE_TX_LIMIT_PER_MONTH
		return { allowed: current < limit, current, limit }
	}

	async canParseImage(userId: string): Promise<LimitResult> {
		const isPrem = await this.isPremiumForUser(userId)
		const now = new Date()
		const startOfMonth = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
		)
		const rows = await this.prisma.transaction.findMany({
			where: {
				userId,
				transactionDate: { gte: startOfMonth, lte: now },
				rawText: { startsWith: 'PHOTO_PARSE:' }
			},
			select: { rawText: true },
			distinct: ['rawText']
		})
		const current = rows.length
		const limit = FREE_LIMITS.MAX_IMAGE_PARSES_PER_MONTH
		if (isPrem) {
			return { allowed: true, current, limit }
		}
		return { allowed: current < limit, current, limit }
	}

	async canStartTrial(userId: string): Promise<{ allowed: boolean; reason?: string }> {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			include: { transactions: { take: 1 } }
		})
		if (!user) return { allowed: false, reason: 'user_not_found' }
		const ledger = await this.prisma.trialLedger.findUnique({
			where: { telegramId: user.telegramId },
			select: { id: true }
		})
		if (user.trialUsed || ledger) return { allowed: false, reason: 'trial_used' }
		if (user.transactions.length === 0)
			return { allowed: false, reason: 'add_transaction_first' }
		return { allowed: true }
	}

	async startTrial(userId: string): Promise<void> {
		const check = await this.canStartTrial(userId)
		if (!check.allowed) throw new Error(check.reason ?? 'Trial not allowed')
		const endDate = addDays(new Date(), TRIAL_DAYS)
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { telegramId: true, stripeCustomerId: true }
		})
		if (!user) throw new Error('user_not_found')
		await this.prisma.$transaction([
			this.prisma.user.update({
				where: { id: userId },
				data: {
					isPremium: true,
					premiumUntil: endDate,
					trialUsed: true
				}
			}),
			this.prisma.subscription.create({
				data: {
					userId,
					plan: SubscriptionPlan.trial,
					status: 'active',
					endDate,
					amount: 0,
					currency: 'EUR'
				}
			}),
			this.prisma.trialLedger.upsert({
				where: { telegramId: user.telegramId },
				update: {
					firstUserId: userId,
					...(user.stripeCustomerId ? { stripeCustomerId: user.stripeCustomerId } : {}),
					usedAt: new Date()
				},
				create: {
					telegramId: user.telegramId,
					firstUserId: userId,
					stripeCustomerId: user.stripeCustomerId ?? null
				}
			})
		])
		await this.trackEvent(userId, PremiumEventType.trial_start)
	}

	async checkAndExpirePremium(): Promise<{ userId: string; telegramId: string }[]> {
		const now = new Date()
		const users = await this.prisma.user.findMany({
			where: {
				isPremium: true,
				premiumUntil: { not: null, lt: now }
			},
			select: { id: true, telegramId: true }
		})
		for (const u of users) {
			await this.prisma.user.update({
				where: { id: u.id },
				data: { isPremium: false, premiumUntil: null }
			})
			await this.prisma.subscription.updateMany({
				where: { userId: u.id, status: 'active', endDate: { lt: now } },
				data: { status: 'expired' }
			})
			await this.trackEvent(u.id, PremiumEventType.trial_end)
		}
		return users.map(u => ({ userId: u.id, telegramId: u.telegramId }))
	}

	async getFrozenItems(userId: string): Promise<FrozenItems> {
		const isPrem = await this.isPremiumForUser(userId)
		if (isPrem)
			return {
				accountIdsOverLimit: [],
				accountAssetCounts: {},
				customCategoryIdsOverLimit: [],
				customTagIdsOverLimit: []
			}

		const accounts = await this.prisma.account.findMany({
			where: { userId, isHidden: false },
			orderBy: { createdAt: 'asc' },
			select: { id: true },
			take: FREE_LIMITS.MAX_ACCOUNTS + 50
		})
		const accountIdsOverLimit =
			accounts.length > FREE_LIMITS.MAX_ACCOUNTS
				? accounts.slice(FREE_LIMITS.MAX_ACCOUNTS).map(a => a.id)
				: []

		const accountAssetCounts: Record<string, { current: number; limit: number }> = {}
		for (let i = 0; i < FREE_LIMITS.MAX_ACCOUNTS && i < accounts.length; i++) {
			const acc = accounts[i]
			const count = await this.prisma.accountAsset.count({
				where: { accountId: acc.id }
			})
			accountAssetCounts[acc.id] = {
				current: count,
				limit: FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
			}
		}

		const customCategories = await this.prisma.category.findMany({
			where: { userId, isDefault: false },
			orderBy: { createdAt: 'asc' },
			select: { id: true }
		})
		const customCategoryIdsOverLimit =
			customCategories.length > FREE_LIMITS.MAX_CUSTOM_CATEGORIES
				? customCategories.slice(FREE_LIMITS.MAX_CUSTOM_CATEGORIES).map(c => c.id)
				: []

		const customTags = await this.prisma.tag.findMany({
			where: { userId, isDefault: false },
			orderBy: { createdAt: 'asc' },
			select: { id: true }
		})
		const customTagIdsOverLimit =
			customTags.length > FREE_LIMITS.MAX_CUSTOM_TAGS
				? customTags.slice(FREE_LIMITS.MAX_CUSTOM_TAGS).map(t => t.id)
				: []

		return {
			accountIdsOverLimit,
			accountAssetCounts,
			customCategoryIdsOverLimit,
			customTagIdsOverLimit
		}
	}

	async trackEvent(
		userId: string,
		type: (typeof PremiumEventType)[keyof typeof PremiumEventType],
		details?: string
	): Promise<void> {
		await this.prisma.premiumEvent.create({
			data: { userId, type, details }
		})
	}

	async getUsersForMonthlyUpsell(): Promise<{ telegramId: string }[]> {
		const since = new Date()
		since.setDate(since.getDate() - 30)
		const users = await this.prisma.user.findMany({
			where: {
				isPremium: false,
				transactions: { some: { createdAt: { gte: since } } }
			},
			select: { telegramId: true }
		})
		return users
	}

	async getUsersForQuarterlyLifetimeOffer(): Promise<{ telegramId: string }[]> {
		const since = new Date()
		since.setDate(since.getDate() - 90)
		const users = await this.prisma.user.findMany({
			where: {
				isPremium: false,
				transactions: { some: { createdAt: { gte: since } } }
			},
			select: { telegramId: true }
		})
		return users
	}

	private async isPremiumForUser(userId: string): Promise<boolean> {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { isPremium: true, premiumUntil: true }
		})
		return user ? this.isPremium(user) : false
	}

	async getSubscriptionDisplay(userId: string): Promise<{
		active: boolean
		planName: string
		endDate: Date | null
		daysLeft: number | null
		amount: number
		currency: string
		periodLabel: string
		isTrial: boolean
		autoRenew: boolean | null
	}> {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { isPremium: true, premiumUntil: true, mainCurrency: true }
		})
		const active = user ? this.isPremium(user) : false
		const mainCurrency = user?.mainCurrency ?? 'EUR'
		if (!active) {
			return {
				active: false,
				planName: 'Free',
				endDate: null,
				daysLeft: null,
				amount: 0,
				currency: mainCurrency,
				periodLabel: 'месяц',
				isTrial: false,
				autoRenew: null
			}
		}
		const sub = await this.prisma.subscription.findFirst({
			where: { userId, status: 'active' },
			orderBy: { createdAt: 'desc' },
			select: {
				plan: true,
				endDate: true,
				amount: true,
				currency: true,
				autoRenew: true
			}
		})
		const planNames: Record<string, string> = {
			monthly: 'Месячный',
			yearly: 'Годовой',
			lifetime: 'Навсегда',
			trial: 'Trial'
		}
		const periodLabels: Record<string, string> = {
			monthly: 'месяц',
			yearly: 'год',
			lifetime: 'навсегда',
			trial: 'trial'
		}
		const endDate = sub?.endDate ?? user?.premiumUntil ?? null
		const now = new Date()
		let daysLeft: number | null = null
		if (endDate && endDate > now) {
			daysLeft = Math.ceil((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
		}
		const plan = sub?.plan ?? 'monthly'
		const isTrial = plan === 'trial'
		return {
			active,
			planName: planNames[plan] ?? plan,
			endDate,
			daysLeft,
			amount: sub?.amount != null ? Number(sub.amount) : 0,
			currency: sub?.currency ?? mainCurrency,
			periodLabel: periodLabels[plan] ?? 'месяц',
			isTrial,
			autoRenew: sub?.autoRenew ?? null
		}
	}
}
