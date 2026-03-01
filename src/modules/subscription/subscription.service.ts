import { Injectable, Logger } from '@nestjs/common'
import type { User } from '../../generated/prisma/client'
import { PremiumEventType, SubscriptionPlan } from '../../generated/prisma/enums'
import { PrismaService } from '../prisma/prisma.service'
import { FREE_LIMITS, TRIAL_DAYS } from './subscription.constants'
import { toDbMoney } from '../../utils/money'
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
const DAY_MS = 24 * 60 * 60 * 1000

@Injectable()
export class SubscriptionService {
	private readonly logger = new Logger(SubscriptionService.name)
	private readonly lastInvoiceAtByUser = new Map<string, number>()

	constructor(private readonly prisma: PrismaService) {}

	private isDbUnreachableError(error: unknown): boolean {
		const maybeAny = error as any
		const code = String(maybeAny?.code ?? '')
		const msg = String(maybeAny?.message ?? maybeAny ?? '').toLowerCase()
		return (
			code === 'P1001' ||
			msg.includes("can't reach database server") ||
			msg.includes('databasenotreachable')
		)
	}

	private isSubscriptionWriteSchemaError(error: unknown): boolean {
		const maybeAny = error as any
		const code = String(maybeAny?.code ?? '')
		const msg = String(maybeAny?.message ?? maybeAny ?? '').toLowerCase()
		return (
			code === 'P2022' ||
			(msg.includes('column') && msg.includes('does not exist')) ||
			msg.includes('amount_decimal') ||
			msg.includes('autorenew')
		)
	}

	private async withDbRetry<T>(task: string, fn: () => Promise<T>): Promise<T> {
		const backoffMs = [1000, 3000]
		let lastError: unknown
		for (let attempt = 1; attempt <= backoffMs.length + 1; attempt++) {
			try {
				return await fn()
			} catch (error: unknown) {
				lastError = error
				const maybeAny = error as any
				const errorCode = String(maybeAny?.code ?? '')
				if (!this.isDbUnreachableError(error) || attempt > backoffMs.length) {
					throw error
				}
				this.logger.warn(
					`DB unreachable in ${task} (attempt ${attempt}/${backoffMs.length + 1}, code=${errorCode || 'unknown'}). Retrying...`
				)
				await new Promise(resolve => setTimeout(resolve, backoffMs[attempt - 1]))
			}
		}
		throw lastError
	}

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
	 * Лимит транзакций в месяц для Basic.
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
			select: {
				id: true,
				telegramId: true,
				trialUsed: true,
				isPremium: true,
				premiumUntil: true
			}
		})
		if (!user) return { allowed: false, reason: 'user_not_found' }
		if (this.isPremium(user)) {
			return { allowed: false, reason: 'already_premium' }
		}
		const trialLedger = await this.prisma.trialLedger.findUnique({
			where: { telegramId: user.telegramId },
			select: { id: true }
		})
		if (user.trialUsed || trialLedger) {
			return { allowed: false, reason: 'trial_used' }
		}
		const visibleAccountsCount = await this.prisma.account.count({
			where: { userId, isHidden: false }
		})
		if (visibleAccountsCount < FREE_LIMITS.MAX_ACCOUNTS) {
			return { allowed: false, reason: 'add_second_account' }
		}
		return { allowed: true }
	}

	async startTrial(userId: string): Promise<Date> {
		const check = await this.canStartTrial(userId)
		if (!check.allowed) throw new Error(check.reason ?? 'Trial not allowed')
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, telegramId: true }
		})
		if (!user) throw new Error('user_not_found')
		const endDate = new Date(Date.now() + TRIAL_DAYS * DAY_MS)
		await this.prisma.$transaction(async tx => {
			await tx.user.update({
				where: { id: userId },
				data: {
					isPremium: true,
					premiumUntil: endDate,
					trialUsed: true
				}
			})
			await tx.trialLedger.upsert({
				where: { telegramId: user.telegramId },
				update: {
					firstUserId: user.id,
					usedAt: new Date()
				},
				create: {
					telegramId: user.telegramId,
					firstUserId: user.id,
					usedAt: new Date()
				}
			})
			try {
				await tx.subscription.create({
					data: {
						userId,
						plan: SubscriptionPlan.trial,
						status: 'active',
						endDate,
						amount: 0,
						amountDecimal: toDbMoney(0) ?? undefined,
						currency: 'EUR'
					}
				})
			} catch (error: unknown) {
				if (!this.isSubscriptionWriteSchemaError(error)) throw error
				const message = String((error as any)?.message ?? error)
				this.logger.warn(
					`Trial granted without subscription row due schema mismatch: ${message}`
				)
			}
		})
		await this.trackEvent(userId, PremiumEventType.trial_start)
		return endDate
	}

	async startTrialIfEligible(
		userId: string
	): Promise<{ started: boolean; endDate?: Date; reason?: string }> {
		const check = await this.canStartTrial(userId)
		if (!check.allowed) {
			return { started: false, reason: check.reason }
		}
		const endDate = await this.startTrial(userId)
		return { started: true, endDate }
	}

	async checkAndExpirePremium(): Promise<
		{ userId: string; telegramId: string; expiredTrial: boolean }[]
	> {
		try {
			return await this.withDbRetry('checkAndExpirePremium', async () => {
				const now = new Date()
				const users = await this.prisma.user.findMany({
					where: {
						isPremium: true,
						premiumUntil: { not: null, lt: now }
					},
					select: { id: true, telegramId: true }
				})
				const expired: {
					userId: string
					telegramId: string
					expiredTrial: boolean
				}[] = []
				for (const u of users) {
					const expiringSubs = await this.prisma.subscription.findMany({
						where: { userId: u.id, status: 'active', endDate: { lt: now } },
						select: { plan: true }
					})
					const hasPaidSubscription = await this.prisma.subscription.findFirst({
						where: {
							userId: u.id,
							plan: {
								in: [
									SubscriptionPlan.monthly,
									SubscriptionPlan.yearly,
									SubscriptionPlan.lifetime
								]
							}
						},
						select: { id: true }
					})
					const expiredTrial =
						expiringSubs.some(s => s.plan === SubscriptionPlan.trial) &&
						!hasPaidSubscription
					await this.prisma.user.update({
						where: { id: u.id },
						data: { isPremium: false, premiumUntil: null }
					})
					await this.prisma.subscription.updateMany({
						where: { userId: u.id, status: 'active', endDate: { lt: now } },
						data: { status: 'expired' }
					})
					if (expiredTrial) {
						await this.trackEvent(u.id, PremiumEventType.trial_end)
					}
					expired.push({
						userId: u.id,
						telegramId: u.telegramId,
						expiredTrial
					})
				}
				return expired
			})
		} catch (error: unknown) {
			if (this.isDbUnreachableError(error)) {
				const code = String((error as any)?.code ?? 'unknown')
				this.logger.warn(
					`checkAndExpirePremium skipped for current tick: DB unreachable (code=${code}).`
				)
				return []
			}
			throw error
		}
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

	async hasMarker(userId: string, marker: string): Promise<boolean> {
		const row = await this.prisma.premiumEvent.findFirst({
			where: { userId, details: marker },
			select: { id: true }
		})
		return !!row
	}

	async markMarkerIfAbsent(
		userId: string,
		marker: string,
		type: (typeof PremiumEventType)[keyof typeof PremiumEventType] = PremiumEventType.upsell_shown
	): Promise<boolean> {
		if (await this.hasMarker(userId, marker)) return false
		await this.trackEvent(userId, type, marker)
		return true
	}

	async getActiveTrialUsersForFunnel(): Promise<
		Array<{
			userId: string
			telegramId: string
			startDate: Date
			endDate: Date | null
		}>
	> {
		try {
			return await this.withDbRetry(
				'getActiveTrialUsersForFunnel',
				async () => {
					const now = new Date()
					const rows = await this.prisma.subscription.findMany({
						where: {
							plan: SubscriptionPlan.trial,
							status: 'active',
							endDate: { gt: now },
							user: {
								isPremium: true,
								subscriptions: {
									none: {
										plan: {
											in: [
												SubscriptionPlan.monthly,
												SubscriptionPlan.yearly,
												SubscriptionPlan.lifetime
											]
										},
										status: 'active'
									}
								}
							}
						},
						select: {
							userId: true,
							startDate: true,
							endDate: true,
							user: { select: { telegramId: true } }
						}
					})
					return rows.map(row => ({
						userId: row.userId,
						telegramId: row.user.telegramId,
						startDate: row.startDate,
						endDate: row.endDate
					}))
				}
			)
		} catch (error: unknown) {
			if (this.isDbUnreachableError(error)) {
				const code = String((error as any)?.code ?? 'unknown')
				this.logger.warn(
					`getActiveTrialUsersForFunnel skipped for current tick: DB unreachable (code=${code}).`
				)
				return []
			}
			throw error
		}
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
		plan: string
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
				plan: 'basic',
				planName: 'Basic',
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
			plan,
			planName: planNames[plan] ?? plan,
			endDate,
			daysLeft,
			amount: sub?.amount ?? 0,
			currency: sub?.currency ?? mainCurrency,
			periodLabel: periodLabels[plan] ?? 'месяц',
			isTrial,
			autoRenew: sub?.autoRenew ?? null
		}
	}
}
