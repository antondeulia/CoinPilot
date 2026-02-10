import { Injectable } from '@nestjs/common'
import type { User } from '../../generated/prisma/client'
import { PremiumEventType, SubscriptionPlan } from '../../generated/prisma/enums'
import { PrismaService } from '../prisma/prisma.service'
import { FREE_LIMITS, TRIAL_DAYS } from './subscription.constants'

function addDays(date: Date, days: number): Date {
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
		if (isPrem) {
			const current = await this.prisma.account.count({ where: { userId } })
			return { allowed: true, current, limit: FREE_LIMITS.MAX_ACCOUNTS }
		}
		const current = await this.prisma.account.count({ where: { userId } })
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
			return { allowed: true, current, limit: FREE_LIMITS.MAX_CUSTOM_TAGS }
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

	async canStartTrial(userId: string): Promise<{ allowed: boolean; reason?: string }> {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			include: { transactions: { take: 1 } }
		})
		if (!user) return { allowed: false, reason: 'user_not_found' }
		if (user.trialUsed) return { allowed: false, reason: 'trial_used' }
		if (user.transactions.length === 0)
			return { allowed: false, reason: 'add_transaction_first' }
		return { allowed: true }
	}

	async startTrial(userId: string): Promise<void> {
		const check = await this.canStartTrial(userId)
		if (!check.allowed) throw new Error(check.reason ?? 'Trial not allowed')
		const endDate = addDays(new Date(), TRIAL_DAYS)
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
			where: { userId },
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
}
