import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'

type NumericLike = number | { toNumber(): number }
const toNum = (value: NumericLike | null | undefined): number =>
	value == null ? 0 : typeof value === 'number' ? value : value.toNumber()

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'week' | 'month' | '3month'

export interface AnalyticsFilters {
	period: AnalyticsPeriod
	accountId?: string
	categoryIds?: string[]
	tagIds?: string[]
}

export interface SummaryResult {
	balance: number
	expenses: number
	income: number
	expensesPrev: number
	incomePrev: number
	expensesTrendPct: number | null
	incomeTrendPct: number | null
	burnRate: number
}

export interface CategorySum {
	categoryId: string | null
	categoryName: string
	sum: number
	pct: number
	tagDetails?: { tagName: string; sum: number }[]
	detailItems?: { label: string; amount: number; currency: string }[]
}

export interface TransferSum {
	fromAccountName: string
	toAccountName: string
	sum: number
	pct: number
	descriptions: string[]
	detailItems?: { label: string; amount: number; currency: string }[]
}

export interface TagSum {
	tagId: string
	tagName: string
	sum: number
	pct: number
}

export interface ByTypeResult {
	expense: number
	income: number
	transfer: number
}

export interface AnomalyRow {
	transactionId: string
	amount: number
	currency: string
	description: string | null
	transactionDate: Date
	tagOrCategory?: string
}

const ROLLING_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 }

function dateRange(period: AnalyticsPeriod): { from: Date; to: Date } {
	const now = new Date()
	const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
	let from: Date
	const days = ROLLING_DAYS[period]
	if (days !== undefined) {
		from = new Date(to)
		from.setDate(from.getDate() - days)
		from.setHours(0, 0, 0, 0)
	} else if (period === 'week') {
		const day = now.getDay()
		const mondayOffset = day === 0 ? -6 : 1 - day
		from = new Date(now)
		from.setDate(now.getDate() + mondayOffset)
		from.setHours(0, 0, 0, 0)
	} else if (period === 'month') {
		from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
	} else {
		// 3month: first day of (current - 2) month
		from = new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0)
	}
	return { from, to }
}

function periodDays(period: AnalyticsPeriod): number {
	const { from, to } = dateRange(period)
	return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)))
}

function prevDateRange(period: AnalyticsPeriod): { from: Date; to: Date } {
	const { from, to } = dateRange(period)
	const span = to.getTime() - from.getTime()
	return {
		from: new Date(from.getTime() - span),
		to: new Date(from.getTime() - 1)
	}
}

@Injectable()
export class AnalyticsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly exchange: ExchangeService
	) {}

	private baseWhere(userId: string, filters: AnalyticsFilters) {
		const { from, to } = dateRange(filters.period)
		const where: any = {
			userId,
			transactionDate: { gte: from, lte: to },
			account: { isHidden: false }
		}
		if (filters.accountId) {
			where.accountId = filters.accountId
		}
		if (filters.categoryIds?.length) {
			const uuidLike = filters.categoryIds.filter(v =>
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					v
				)
			)
			const byName = filters.categoryIds.filter(v => !uuidLike.includes(v))
			if (uuidLike.length && byName.length) {
				where.OR = [
					{ categoryId: { in: uuidLike } },
					{ category: { in: byName } }
				]
			} else if (uuidLike.length) {
				where.categoryId = { in: uuidLike }
			} else {
				where.category = { in: byName }
			}
		}
		if (filters.tagIds?.length) {
			where.tagId = { in: filters.tagIds }
		}
		return { where, from, to }
	}

	getDateRange(period: AnalyticsPeriod): { from: Date; to: Date } {
		return dateRange(period)
	}

	/** Net transfer effect in main currency: positive = money into wallet from external */
	async getTransferCashflow(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const { from, to } = dateRange(period)
		const transferTxs = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'transfer',
				toAccountId: { not: null },
				transactionDate: { gte: from, lte: to },
				...(accountId
					? {
							OR: [
								{ accountId, toAccount: { isHidden: true } },
								{ toAccountId: accountId, account: { isHidden: true } }
							]
						}
					: {
							OR: [
								{ account: { userId, isHidden: false }, toAccount: { isHidden: true } },
								{ account: { userId, isHidden: true }, toAccount: { isHidden: false } }
							]
						})
			},
			select: {
				amount: true,
				currency: true,
				convertedAmount: true,
				convertToCurrency: true,
				account: { select: { isHidden: true } },
				toAccount: { select: { isHidden: true } }
			}
		})
		let net = 0
		for (const tx of transferTxs) {
			const amt =
				tx.convertedAmount != null && tx.convertToCurrency
					? tx.convertedAmount
					: tx.amount
			const cur =
				tx.convertedAmount != null && tx.convertToCurrency
					? tx.convertToCurrency
					: tx.currency
			const inMain = await this.toMainCurrency(
				amt,
				cur,
				mainCurrency,
				(tx as any).transactionDate,
				(tx as any).amountUsd
			)
			const toExternal = tx.toAccount?.isHidden === true
			net += toExternal ? -inMain : inMain
		}
		return net
	}

	async getExternalTransferOutTotal(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const { from, to } = dateRange(period)
		const rows = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'transfer',
				transactionDate: { gte: from, lte: to },
				...(accountId
					? { accountId, toAccount: { isHidden: true } }
					: {
							account: { userId, isHidden: false },
							toAccount: { isHidden: true }
						})
			},
			select: {
				amount: true,
				currency: true,
				convertedAmount: true,
				convertToCurrency: true
			}
		})
		let total = 0
		for (const r of rows) {
			const amt =
				r.convertedAmount != null && r.convertToCurrency
					? r.convertedAmount
					: r.amount
			const cur =
				r.convertedAmount != null && r.convertToCurrency
					? r.convertToCurrency
					: r.currency
			total += await this.toMainCurrency(
				amt,
				cur,
				mainCurrency,
				(r as any).transactionDate,
				(r as any).amountUsd
			)
		}
		return total
	}

	async getCashflow(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const [summary, transferCf] = await Promise.all([
			this.getSummary(userId, period, mainCurrency, accountId),
			this.getTransferCashflow(userId, period, mainCurrency, accountId)
		])
		return summary.income - summary.expenses + transferCf
	}

	async getBeginningBalance(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const [summary, transferCf] = await Promise.all([
			this.getSummary(userId, period, mainCurrency, accountId),
			this.getTransferCashflow(userId, period, mainCurrency, accountId)
		])
		return summary.balance - (summary.income - summary.expenses) - transferCf
	}

	async getTransfersTotal(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }
		const rows = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'transfer',
				transactionDate: { gte: from, lte: to },
				...accountFilter
			},
			select: {
				amount: true,
				currency: true,
				convertedAmount: true,
				convertToCurrency: true
			}
		})
		let total = 0
		for (const r of rows) {
			const amt =
				r.convertedAmount != null && r.convertToCurrency
					? r.convertedAmount
					: r.amount
			const cur =
				r.convertedAmount != null && r.convertToCurrency
					? r.convertToCurrency
					: r.currency
			total += await this.toMainCurrency(
				amt,
				cur,
				mainCurrency,
				(r as any).transactionDate,
				(r as any).amountUsd
			)
		}
		return total
	}

	async getTopTransfers(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		limit = 10,
		accountId?: string,
		beginningBalance?: number
	): Promise<TransferSum[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }
		const txs = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'transfer',
				transactionDate: { gte: from, lte: to },
				...accountFilter
			},
			select: {
				fromAccountId: true,
				toAccountId: true,
				amount: true,
				currency: true,
				convertedAmount: true,
				convertToCurrency: true,
				description: true,
				tagId: true
			}
		})
		const tagIds = [...new Set(txs.map(t => t.tagId).filter(Boolean))] as string[]
		const tags = tagIds.length
			? await this.prisma.tag.findMany({
					where: { id: { in: tagIds } },
					select: { id: true, name: true }
				})
			: []
		const tagIdToName = new Map(tags.map(t => [t.id, t.name]))
		const keyToRows = new Map<string, typeof txs>()
		for (const t of txs) {
			const key = `${t.fromAccountId ?? ''}\t${t.toAccountId ?? ''}`
			if (!keyToRows.has(key)) keyToRows.set(key, [])
			keyToRows.get(key)!.push(t)
		}
		const sums: {
			key: string
			sum: number
			descriptions: string[]
			detailItems: { label: string; amount: number; currency: string; inMain: number }[]
		}[] = []
		for (const [, rows] of keyToRows) {
			let sum = 0
			const descriptions: string[] = []
			const detailItems: {
				label: string
				amount: number
				currency: string
				inMain: number
			}[] = []
			for (const r of rows) {
				const amt =
					r.convertedAmount != null && r.convertToCurrency
						? r.convertedAmount
						: r.amount
				const cur =
					r.convertedAmount != null && r.convertToCurrency
						? r.convertToCurrency!
						: r.currency
				const inMain = await this.toMainCurrency(
					amt,
					cur,
					mainCurrency,
					(r as any).transactionDate,
					(r as any).amountUsd
				)
				sum += inMain
					const label = r.description?.trim() || '—'
					descriptions.push(label)
					detailItems.push({
						label,
						amount: Math.abs(toNum(r.amount)),
						currency: r.currency,
						inMain
					})
			}
			sums.push({
				key: rows[0] ? `${rows[0].fromAccountId}\t${rows[0].toAccountId}` : '',
				sum,
				descriptions: [...new Set(descriptions)],
				detailItems
			})
		}
		sums.sort((a, b) => b.sum - a.sum)
		const top = sums.slice(0, limit)
		const accountIds = new Set<string>()
		for (const s of top) {
			const [fromId, toId] = s.key.split('\t')
			if (fromId) accountIds.add(fromId)
			if (toId) accountIds.add(toId)
		}
		const accounts = await this.prisma.account.findMany({
			where: { id: { in: Array.from(accountIds) } },
			select: { id: true, name: true }
		})
		const idToName = new Map(accounts.map(a => [a.id, a.name]))
		const denom =
			beginningBalance != null && beginningBalance > 0 ? beginningBalance : 1
		return top.map(s => {
			const [fromId, toId] = s.key.split('\t')
			const detailItems = [...s.detailItems]
				.sort((a, b) => b.inMain - a.inMain)
				.slice(0, 3)
				.map(({ label, amount, currency }) => ({ label, amount, currency }))
			return {
				fromAccountName: idToName.get(fromId) ?? (fromId ? '—' : 'Вне Wallet'),
				toAccountName: idToName.get(toId) ?? (toId ? '—' : 'Вне Wallet'),
				sum: s.sum,
				pct: (s.sum / denom) * 100,
				descriptions: s.descriptions,
				detailItems
			}
		})
	}

	async getTopIncomeCategories(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		beginningBalance: number,
		limit = 5,
		accountId?: string
	): Promise<CategorySum[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }
		const rows = await this.prisma.transaction.groupBy({
			by: ['categoryId', 'category'],
			where: {
				userId,
				direction: 'income',
				transactionDate: { gte: from, lte: to },
				OR: [{ categoryId: { not: null } }, { category: { not: null } }],
				...accountFilter
			},
			_sum: { amount: true }
		})
		const withConverted: {
			categoryId: string | null
			name: string
			sum: number
			tagSums: Map<string, number>
			detailItems: { label: string; amount: number; currency: string; inMain: number }[]
		}[] = []
		for (const r of rows) {
			const txs = await this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'income',
					transactionDate: { gte: from, lte: to },
					...(r.categoryId
						? { categoryId: r.categoryId }
						: { category: r.category }),
					...accountFilter
				},
				select: {
					amount: true,
					currency: true,
					convertedAmount: true,
					convertToCurrency: true,
					tagId: true,
					description: true
				}
			})
			let sum = 0
			const tagSums = new Map<string, number>()
			const detailItems: {
				label: string
				amount: number
				currency: string
				inMain: number
			}[] = []
			const tagIds = [...new Set(txs.map(t => t.tagId).filter(Boolean))] as string[]
			const tags = tagIds.length
				? await this.prisma.tag.findMany({
						where: { id: { in: tagIds } },
						select: { id: true, name: true }
					})
				: []
			const tagIdToName = new Map(tags.map(t => [t.id, t.name]))
			for (const t of txs) {
				const amt =
					t.convertedAmount != null && t.convertToCurrency
						? t.convertedAmount
						: t.amount
				const cur =
					t.convertedAmount != null && t.convertToCurrency
						? t.convertToCurrency!
						: t.currency
				const inMain = await this.toMainCurrency(
					amt,
					cur,
					mainCurrency,
					(t as any).transactionDate,
					(t as any).amountUsd
				)
				sum += inMain
					const label = t.description?.trim() || '—'
					detailItems.push({
						label,
					amount: Math.abs(toNum(t.amount)),
					currency: t.currency,
					inMain
				})
				if (t.tagId) {
					const tagName = tagIdToName.get(t.tagId) ?? '—'
					tagSums.set(tagName, (tagSums.get(tagName) ?? 0) + inMain)
				}
			}
			withConverted.push({
				categoryId: r.categoryId ?? null,
				name: r.category ?? '📦Другое',
				sum,
				tagSums,
				detailItems
			})
		}
		withConverted.sort((a, b) => b.sum - a.sum)
		const topCategoryIds = withConverted
			.slice(0, limit)
			.map(c => c.categoryId)
			.filter((v): v is string => !!v)
		const categories = topCategoryIds.length
			? await this.prisma.category.findMany({
					where: { userId, id: { in: topCategoryIds } },
					select: { id: true, name: true }
				})
			: []
		const idToName = new Map(categories.map(c => [c.id, c.name]))
		const denom = beginningBalance > 0 ? beginningBalance : 1
		return withConverted.slice(0, limit).map(c => ({
			categoryId: c.categoryId,
			categoryName: c.categoryId ? idToName.get(c.categoryId) ?? c.name : c.name,
			sum: c.sum,
			pct: (c.sum / denom) * 100,
			tagDetails: Array.from(c.tagSums.entries()).map(([tagName, s]) => ({ tagName, sum: s })),
			detailItems: [...c.detailItems]
				.sort((a, b) => b.inMain - a.inMain)
				.slice(0, 3)
				.map(({ label, amount, currency }) => ({ label, amount, currency }))
		}))
	}

	private async toMainCurrency(
		amount: NumericLike,
		currency: string,
		mainCurrency: string,
		transactionDate?: Date,
		amountUsd?: NumericLike | null
	): Promise<number> {
		if (transactionDate) {
			const rate = await this.exchange.getHistoricalRate(
				transactionDate,
				currency,
				mainCurrency
			)
			if (rate != null) return toNum(amount) * rate
		}
		if (amountUsd != null) {
			const fromUsd = await this.exchange.convert(
				toNum(amountUsd),
				'USD',
				mainCurrency
			)
			if (fromUsd != null) return fromUsd
		}
		const v = await this.exchange.convert(toNum(amount), currency, mainCurrency)
		if (v != null) return v
		return toNum(amount)
	}

	async getSummary(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<SummaryResult> {
		const filters: AnalyticsFilters = { period, accountId }
		const { from, to } = dateRange(period)
		const prev = prevDateRange(period)

		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }

		const [incomeRows, expenseRows, incomePrevRows, expensePrevRows, assets] =
			await Promise.all([
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'income',
						transactionDate: { gte: from, lte: to },
						...accountFilter
					},
					select: {
						amount: true,
						currency: true,
						convertedAmount: true,
						convertToCurrency: true
					}
				}),
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'expense',
						transactionDate: { gte: from, lte: to },
						...accountFilter
					},
					select: {
						amount: true,
						currency: true,
						convertedAmount: true,
						convertToCurrency: true
					}
				}),
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'income',
						transactionDate: { gte: prev.from, lte: prev.to },
						...accountFilter
					},
					select: {
						amount: true,
						currency: true,
						convertedAmount: true,
						convertToCurrency: true
					}
				}),
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'expense',
						transactionDate: { gte: prev.from, lte: prev.to },
						...accountFilter
					},
					select: {
						amount: true,
						currency: true,
						convertedAmount: true,
						convertToCurrency: true
					}
				}),
				accountId
					? this.prisma.accountAsset.findMany({
							where: { accountId },
							select: { currency: true, amount: true }
						})
					: this.prisma.accountAsset.findMany({
							where: { account: { userId, isHidden: false } },
							select: { currency: true, amount: true }
						})
			])

			const sumInMain = async (
				rows: {
					amount: NumericLike
					currency: string
					convertedAmount: NumericLike | null
					convertToCurrency: string | null
				}[]
			) => {
			let total = 0
			for (const r of rows) {
				const amt =
					r.convertedAmount != null && r.convertToCurrency
						? r.convertedAmount
						: r.amount
				const cur =
					r.convertedAmount != null && r.convertToCurrency
						? r.convertToCurrency
						: r.currency
				total += await this.toMainCurrency(
					amt,
					cur,
					mainCurrency,
					(r as any).transactionDate,
					(r as any).amountUsd
				)
			}
			return total
		}

		const [income, expenses, incomePrev, expensesPrev, balance] = await Promise.all([
			sumInMain(incomeRows),
			sumInMain(expenseRows),
			sumInMain(incomePrevRows),
			sumInMain(expensePrevRows),
			(async () => {
				let b = 0
				for (const a of assets) {
					b += await this.toMainCurrency(a.amount, a.currency, mainCurrency)
				}
				return b
			})()
		])

		const expensesTrendPct =
			expensesPrev > 0 ? ((expenses - expensesPrev) / expensesPrev) * 100 : null
		const incomeTrendPct =
			incomePrev > 0 ? ((income - incomePrev) / incomePrev) * 100 : null
		const burnRate = periodDays(period) > 0 ? expenses / periodDays(period) : 0

		return {
			balance,
			expenses,
			income,
			expensesPrev,
			incomePrev,
			expensesTrendPct,
			incomeTrendPct,
			burnRate
		}
	}

	async getTopCategories(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		limit = 5,
		accountId?: string,
		beginningBalance?: number
	): Promise<CategorySum[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }

		const rows = await this.prisma.transaction.groupBy({
			by: ['categoryId', 'category'],
			where: {
				userId,
				direction: 'expense',
				transactionDate: { gte: from, lte: to },
				OR: [{ categoryId: { not: null } }, { category: { not: null } }],
				...accountFilter
			},
			_sum: { amount: true },
			_count: true
		})

		const withConverted: {
			categoryId: string | null
			name: string
			sum: number
			tagSums: Map<string, number>
			detailItems: { label: string; amount: number; currency: string; inMain: number }[]
		}[] = []
		for (const r of rows) {
			const txs = await this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: from, lte: to },
					...(r.categoryId
						? { categoryId: r.categoryId }
						: { category: r.category }),
					...accountFilter
				},
				select: {
					amount: true,
					currency: true,
					convertedAmount: true,
					convertToCurrency: true,
					tagId: true,
					description: true
				}
			})
			let sum = 0
			const tagSums = new Map<string, number>()
			const detailItems: {
				label: string
				amount: number
				currency: string
				inMain: number
			}[] = []
			const tagIds = [...new Set(txs.map(t => t.tagId).filter(Boolean))] as string[]
			const tags = tagIds.length
				? await this.prisma.tag.findMany({
						where: { id: { in: tagIds } },
						select: { id: true, name: true }
					})
				: []
			const tagIdToName = new Map(tags.map(t => [t.id, t.name]))
			for (const t of txs) {
				const amt =
					t.convertedAmount != null && t.convertToCurrency
						? t.convertedAmount
						: t.amount
				const cur =
					t.convertedAmount != null && t.convertToCurrency
						? t.convertToCurrency!
						: t.currency
				const inMain = await this.toMainCurrency(
					amt,
					cur,
					mainCurrency,
					(t as any).transactionDate,
					(t as any).amountUsd
				)
				sum += inMain
					const label = t.description?.trim() || '—'
					detailItems.push({
						label,
					amount: Math.abs(toNum(t.amount)),
					currency: t.currency,
					inMain
				})
				if (t.tagId) {
					const tagName = tagIdToName.get(t.tagId) ?? '—'
					tagSums.set(tagName, (tagSums.get(tagName) ?? 0) + inMain)
				}
			}
			withConverted.push({
				categoryId: r.categoryId ?? null,
				name: r.category ?? '📦Другое',
				sum,
				tagSums,
				detailItems
			})
		}
		withConverted.sort((a, b) => b.sum - a.sum)
		const topCategoryIds = withConverted
			.slice(0, limit)
			.map(c => c.categoryId)
			.filter((v): v is string => !!v)
		const categories = topCategoryIds.length
			? await this.prisma.category.findMany({
					where: { userId, id: { in: topCategoryIds } },
					select: { id: true, name: true }
				})
			: []
		const idToName = new Map(categories.map(c => [c.id, c.name]))
		const denom = (beginningBalance != null && beginningBalance > 0) ? beginningBalance : 1
		return withConverted.slice(0, limit).map(c => ({
			categoryId: c.categoryId,
			categoryName: c.categoryId ? idToName.get(c.categoryId) ?? c.name : c.name,
			sum: c.sum,
			pct: (c.sum / denom) * 100,
			tagDetails: Array.from(c.tagSums.entries()).map(([tagName, s]) => ({ tagName, sum: s })),
			detailItems: [...c.detailItems]
				.sort((a, b) => b.inMain - a.inMain)
				.slice(0, 3)
				.map(({ label, amount, currency }) => ({ label, amount, currency }))
		}))
	}

	async getTopTags(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		limit = 10,
		accountId?: string
	): Promise<TagSum[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }

		const rows = await this.prisma.transaction.groupBy({
			by: ['tagId'],
			where: {
				userId,
				direction: 'expense',
				transactionDate: { gte: from, lte: to },
				tagId: { not: null },
				...accountFilter
			},
			_sum: { amount: true }
		})

		let totalExpenses = 0
		const withConverted: { tagId: string; tagName: string; sum: number }[] = []
		for (const r of rows) {
			if (!r.tagId) continue
			const txs = await this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: from, lte: to },
					tagId: r.tagId,
					...accountFilter
				},
				select: {
					amount: true,
					currency: true,
					convertedAmount: true,
					convertToCurrency: true
				}
			})
			let sum = 0
			for (const t of txs) {
				const amt =
					t.convertedAmount != null && t.convertToCurrency
						? t.convertedAmount
						: t.amount
				const cur =
					t.convertedAmount != null && t.convertToCurrency
						? t.convertToCurrency!
						: t.currency
				sum += await this.toMainCurrency(
					amt,
					cur,
					mainCurrency,
					(t as any).transactionDate,
					(t as any).amountUsd
				)
			}
			totalExpenses += sum
			const tag = await this.prisma.tag.findUnique({
				where: { id: r.tagId },
				select: { name: true }
			})
			withConverted.push({
				tagId: r.tagId,
				tagName: tag?.name ?? '—',
				sum
			})
		}
		withConverted.sort((a, b) => b.sum - a.sum)
		const top = withConverted.slice(0, limit)
		return top.map(t => ({
			...t,
			pct: totalExpenses > 0 ? (t.sum / totalExpenses) * 100 : 0
		}))
	}

	async getByType(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<ByTypeResult> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }

		const [expenseRows, incomeRows, transferRows] = await Promise.all([
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: {
					amount: true,
					currency: true,
					convertedAmount: true,
					convertToCurrency: true
				}
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'income',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: {
					amount: true,
					currency: true,
					convertedAmount: true,
					convertToCurrency: true
				}
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'transfer',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: {
					amount: true,
					currency: true,
					convertedAmount: true,
					convertToCurrency: true
				}
			})
		])

			const sum = async (
				rows: {
					amount: NumericLike
					currency: string
					convertedAmount: NumericLike | null
					convertToCurrency: string | null
				}[]
			) => {
			let total = 0
			for (const r of rows) {
				const amt =
					r.convertedAmount != null && r.convertToCurrency
						? r.convertedAmount
						: r.amount
				const cur =
					r.convertedAmount != null && r.convertToCurrency
						? r.convertToCurrency
						: r.currency
				total += await this.toMainCurrency(amt, cur, mainCurrency)
			}
			return total
		}

		const [expense, income, transfer] = await Promise.all([
			sum(expenseRows),
			sum(incomeRows),
			sum(transferRows)
		])
		return { expense, income, transfer }
	}

	async getTradeFeesTotal(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }
		const rows = await this.prisma.transaction.findMany({
			where: {
				userId,
				tradeType: { in: ['buy', 'sell'] },
				tradeFeeAmount: { not: null },
				transactionDate: { gte: from, lte: to },
				...accountFilter
			},
			select: {
				tradeFeeAmount: true,
				tradeFeeCurrency: true,
				transactionDate: true,
				amountUsd: true
			}
		})
		let total = 0
		for (const row of rows) {
			const feeAmount = row.tradeFeeAmount
			const feeCurrency = row.tradeFeeCurrency
			if (feeAmount == null || !feeCurrency) continue
			total += await this.toMainCurrency(
				feeAmount,
				feeCurrency,
				mainCurrency,
				row.transactionDate,
				row.amountUsd
			)
		}
		return total
	}

	async getAnomalies(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		threshold: number,
		accountId?: string,
		beginningBalance?: number
	): Promise<AnomalyRow[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }
		const effectiveThreshold =
			beginningBalance != null && beginningBalance > 0
				? beginningBalance * 0.5
				: threshold

		const txs = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'expense',
				transactionDate: { gte: from, lte: to },
				...accountFilter
			},
			select: {
				id: true,
				amount: true,
				currency: true,
				description: true,
				transactionDate: true,
				convertedAmount: true,
				convertToCurrency: true,
				category: true,
				tagId: true
			},
			orderBy: { amount: 'desc' }
		})

		const tagIds = [...new Set(txs.map(t => t.tagId).filter(Boolean))] as string[]
		const tags = tagIds.length
			? await this.prisma.tag.findMany({
					where: { id: { in: tagIds } },
					select: { id: true, name: true }
				})
			: []
		const tagIdToName = new Map(tags.map(t => [t.id, t.name]))

		const result: AnomalyRow[] = []
		for (const t of txs) {
			const amt =
				t.convertedAmount != null && t.convertToCurrency
					? await this.toMainCurrency(
							t.convertedAmount,
							t.convertToCurrency,
							mainCurrency
						)
					: await this.toMainCurrency(
							t.amount,
							t.currency,
							mainCurrency,
							t.transactionDate,
							(t as any).amountUsd
						)
			if (amt >= effectiveThreshold) {
				const tagOrCategory = t.tagId
					? (tagIdToName.get(t.tagId) ?? null)
					: (t.category ?? null)
				result.push({
					transactionId: t.id,
					amount: amt,
					currency: mainCurrency,
					description: t.description,
					transactionDate: t.transactionDate,
					tagOrCategory: tagOrCategory ?? undefined
				})
			}
		}
		return result
	}

	async getBurnRate(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<number> {
		const summary = await this.getSummary(userId, period, mainCurrency, accountId)
		return summary.burnRate
	}

	async getCategoryDetail(
		userId: string,
		categoryName: string,
		period: AnalyticsPeriod,
		page: number,
		pageSize: number,
		mainCurrency: string,
		accountId?: string
	): Promise<{ transactions: AnomalyRow[]; total: number }> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }

		const [total, txs] = await Promise.all([
			this.prisma.transaction.count({
				where: {
					userId,
					direction: 'expense',
					category: categoryName,
					transactionDate: { gte: from, lte: to },
					...accountFilter
				}
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					category: categoryName,
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: {
					id: true,
					amount: true,
					currency: true,
					description: true,
					transactionDate: true,
					convertedAmount: true,
					convertToCurrency: true
				},
				orderBy: { transactionDate: 'desc' },
				skip: page * pageSize,
				take: pageSize
			})
		])

		const transactions: AnomalyRow[] = []
		for (const t of txs) {
			const amt =
				t.convertedAmount != null && t.convertToCurrency
					? await this.toMainCurrency(
							t.convertedAmount,
							t.convertToCurrency,
							mainCurrency
						)
					: await this.toMainCurrency(
							t.amount,
							t.currency,
							mainCurrency,
							t.transactionDate,
							(t as any).amountUsd
						)
			transactions.push({
				transactionId: t.id,
				amount: amt,
				currency: mainCurrency,
				description: t.description,
				transactionDate: t.transactionDate
			})
		}
		return { transactions, total }
	}

	async getTagDetail(
		userId: string,
		tagId: string,
		period: AnalyticsPeriod,
		page: number,
		pageSize: number,
		mainCurrency: string,
		accountId?: string
	): Promise<{ transactions: AnomalyRow[]; total: number }> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }

		const [total, txs] = await Promise.all([
			this.prisma.transaction.count({
				where: {
					userId,
					direction: 'expense',
					tagId,
					transactionDate: { gte: from, lte: to },
					...accountFilter
				}
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					tagId,
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: {
					id: true,
					amount: true,
					currency: true,
					description: true,
					transactionDate: true,
					convertedAmount: true,
					convertToCurrency: true
				},
				orderBy: { transactionDate: 'desc' },
				skip: page * pageSize,
				take: pageSize
			})
		])

		const transactions: AnomalyRow[] = []
		for (const t of txs) {
			const amt =
				t.convertedAmount != null && t.convertToCurrency
					? await this.toMainCurrency(
							t.convertedAmount,
							t.convertToCurrency,
							mainCurrency
						)
					: await this.toMainCurrency(
							t.amount,
							t.currency,
							mainCurrency,
							t.transactionDate,
							(t as any).amountUsd
						)
			transactions.push({
				transactionId: t.id,
				amount: amt,
				currency: mainCurrency,
				description: t.description,
				transactionDate: t.transactionDate
			})
		}
		return { transactions, total }
	}

	async getFilteredSummary(
		userId: string,
		filters: AnalyticsFilters,
		mainCurrency: string
	): Promise<SummaryResult> {
		return this.getSummary(userId, filters.period, mainCurrency, filters.accountId)
	}
}
