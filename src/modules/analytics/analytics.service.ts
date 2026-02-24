import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'
import { pickMoneyNumber } from '../../utils/money'

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
	descriptionDetails?: { description: string; sum: number }[]
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
const UUID_RE = /^[0-9a-f-]{36}$/i

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

	private pickTxAmount(tx: {
		amount: number
		amountDecimal?: unknown
		currency: string
		convertedAmount?: number | null
		convertedAmountDecimal?: unknown
		convertToCurrency?: string | null
	}): { amount: number; currency: string } {
		const useConverted = tx.convertedAmount != null && !!tx.convertToCurrency
		if (useConverted) {
			return {
				amount: pickMoneyNumber(tx.convertedAmountDecimal, tx.convertedAmount, 0),
				currency: tx.convertToCurrency!
			}
		}
		return {
			amount: pickMoneyNumber(tx.amountDecimal, tx.amount, 0),
			currency: tx.currency
		}
	}

	private pickAmountUsd(tx: {
		amountUsd?: number | null
		amountUsdDecimal?: unknown
	}): number | null {
		if (tx.amountUsd == null && tx.amountUsdDecimal == null) return null
		return pickMoneyNumber(tx.amountUsdDecimal, tx.amountUsd, 0)
	}

	private async resolveCategoryWhere(userId: string, categoryIdOrName: string) {
		if (UUID_RE.test(categoryIdOrName)) {
			const category = await this.prisma.category.findFirst({
				where: { id: categoryIdOrName, userId },
				select: { name: true }
			})
			return {
				OR: [
					{ categoryId: categoryIdOrName },
					...(category?.name
						? [{ categoryId: null, category: category.name }]
						: [])
				]
			}
		}
		return { category: categoryIdOrName }
	}

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
			where.categoryId = { in: filters.categoryIds }
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
				amountDecimal: true,
				currency: true,
				convertedAmount: true,
				convertedAmountDecimal: true,
				convertToCurrency: true,
				transactionDate: true,
				amountUsd: true,
				amountUsdDecimal: true,
				account: { select: { isHidden: true } },
				toAccount: { select: { isHidden: true } }
			}
		})
		let net = 0
		for (const tx of transferTxs) {
			const { amount, currency } = this.pickTxAmount(tx)
			const inMain = await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				tx.transactionDate,
				this.pickAmountUsd(tx)
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
				amountDecimal: true,
				currency: true,
				convertedAmount: true,
				convertedAmountDecimal: true,
				convertToCurrency: true,
				transactionDate: true,
				amountUsd: true,
				amountUsdDecimal: true
			}
		})
		let total = 0
		for (const r of rows) {
			const { amount, currency } = this.pickTxAmount(r)
			total += await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				r.transactionDate,
				this.pickAmountUsd(r)
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
				amountDecimal: true,
				currency: true,
				convertedAmount: true,
				convertedAmountDecimal: true,
				convertToCurrency: true,
				description: true,
				transactionDate: true,
				amountUsd: true,
				amountUsdDecimal: true
			}
		})
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
				const { amount, currency } = this.pickTxAmount(r)
				const inMain = await this.toMainCurrency(
					amount,
					currency,
					mainCurrency,
					r.transactionDate,
					this.pickAmountUsd(r)
				)
				sum += inMain
				const label = r.description?.trim() || '—'
				descriptions.push(label)
				detailItems.push({
					label,
					amount: Math.abs(r.amount),
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
		const txs = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'income',
				transactionDate: { gte: from, lte: to },
				OR: [{ categoryId: { not: null } }, { category: { not: null } }],
				...accountFilter
			},
			select: {
				categoryId: true,
				category: true,
				amount: true,
				amountDecimal: true,
				currency: true,
				convertedAmount: true,
				convertedAmountDecimal: true,
				convertToCurrency: true,
				description: true,
				transactionDate: true,
				amountUsd: true,
				amountUsdDecimal: true
			}
		})
		if (!txs.length) return []
		const categoryIds = Array.from(
			new Set(txs.map(t => t.categoryId).filter(Boolean) as string[])
		)
		const categories = categoryIds.length
			? await this.prisma.category.findMany({
					where: { userId, id: { in: categoryIds } },
					select: { id: true, name: true }
				})
			: []
		const idToName = new Map(categories.map(c => [c.id, c.name]))
		const grouped = new Map<
			string,
			{
				categoryId: string | null
				categoryName: string
				sum: number
				descriptionSums: Map<string, number>
			}
		>()
		for (const tx of txs) {
			const categoryName =
				(tx.categoryId ? idToName.get(tx.categoryId) : null) ??
				tx.category ??
				'📦Другое'
			const key = tx.categoryId
				? `id:${tx.categoryId}`
				: `name:${categoryName.toLowerCase()}`
			if (!grouped.has(key)) {
				grouped.set(key, {
					categoryId: tx.categoryId ?? null,
					categoryName,
					sum: 0,
					descriptionSums: new Map<string, number>()
				})
			}
			const current = grouped.get(key)!
			const { amount, currency } = this.pickTxAmount(tx)
			const inMain = await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				tx.transactionDate,
				this.pickAmountUsd(tx)
			)
			current.sum += inMain
			const label = tx.description?.trim() || '—'
			current.descriptionSums.set(
				label,
				(current.descriptionSums.get(label) ?? 0) + inMain
			)
		}
		const denom = beginningBalance > 0 ? beginningBalance : 1
		return Array.from(grouped.values())
			.sort((a, b) => b.sum - a.sum)
			.slice(0, limit)
			.map(c => ({
				categoryId: c.categoryId,
				categoryName: c.categoryName,
				sum: c.sum,
				pct: (c.sum / denom) * 100,
				descriptionDetails: Array.from(c.descriptionSums.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 3)
					.map(([description, s]) => ({ description, sum: s }))
			}))
	}

	private async toMainCurrency(
		amount: number,
		currency: string,
		mainCurrency: string,
		transactionDate?: Date,
		amountUsd?: number | null
	): Promise<number> {
		if (transactionDate) {
			const rate = await this.exchange.getHistoricalRate(
				transactionDate,
				currency,
				mainCurrency
			)
			if (rate != null) return amount * rate
		}
		if (amountUsd != null) {
			const fromUsd = await this.exchange.convert(amountUsd, 'USD', mainCurrency)
			if (fromUsd != null) return fromUsd
		}
		const v = await this.exchange.convert(amount, currency, mainCurrency)
		if (v != null) return v
		return amount
	}

	async getSummary(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		accountId?: string
	): Promise<SummaryResult> {
		const { from, to } = dateRange(period)
		const prev = prevDateRange(period)

		const accountFilter = accountId
			? { accountId }
			: { account: { userId, isHidden: false } }
		const txSelect = {
			amount: true,
			amountDecimal: true,
			currency: true,
			convertedAmount: true,
			convertedAmountDecimal: true,
			convertToCurrency: true,
			transactionDate: true,
			amountUsd: true,
			amountUsdDecimal: true
		} as const

		const [incomeRows, expenseRows, incomePrevRows, expensePrevRows, assets] =
			await Promise.all([
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'income',
						transactionDate: { gte: from, lte: to },
						...accountFilter
					},
					select: txSelect
				}),
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'expense',
						transactionDate: { gte: from, lte: to },
						...accountFilter
					},
					select: txSelect
				}),
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'income',
						transactionDate: { gte: prev.from, lte: prev.to },
						...accountFilter
					},
					select: txSelect
				}),
				this.prisma.transaction.findMany({
					where: {
						userId,
						direction: 'expense',
						transactionDate: { gte: prev.from, lte: prev.to },
						...accountFilter
					},
					select: txSelect
				}),
				accountId
					? this.prisma.accountAsset.findMany({
							where: { accountId },
							select: { currency: true, amount: true, amountDecimal: true }
						})
					: this.prisma.accountAsset.findMany({
							where: { account: { userId, isHidden: false } },
							select: { currency: true, amount: true, amountDecimal: true }
						})
			])

		const sumInMain = async (
			rows: {
				amount: number
				amountDecimal: unknown
				currency: string
				convertedAmount: number | null
				convertedAmountDecimal: unknown
				convertToCurrency: string | null
				transactionDate: Date
				amountUsd: number | null
				amountUsdDecimal: unknown
			}[]
		) => {
			let total = 0
			for (const r of rows) {
				const { amount, currency } = this.pickTxAmount(r)
				total += await this.toMainCurrency(
					amount,
					currency,
					mainCurrency,
					r.transactionDate,
					this.pickAmountUsd(r)
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
					b += await this.toMainCurrency(
						pickMoneyNumber(a.amountDecimal, a.amount, 0),
						a.currency,
						mainCurrency
					)
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
		const txs = await this.prisma.transaction.findMany({
			where: {
				userId,
				direction: 'expense',
				transactionDate: { gte: from, lte: to },
				OR: [{ categoryId: { not: null } }, { category: { not: null } }],
				...accountFilter
			},
			select: {
				categoryId: true,
				category: true,
				amount: true,
				amountDecimal: true,
				currency: true,
				convertedAmount: true,
				convertedAmountDecimal: true,
				convertToCurrency: true,
				description: true,
				transactionDate: true,
				amountUsd: true,
				amountUsdDecimal: true
			}
		})
		if (!txs.length) return []
		const categoryIds = Array.from(
			new Set(txs.map(t => t.categoryId).filter(Boolean) as string[])
		)
		const categories = categoryIds.length
			? await this.prisma.category.findMany({
					where: { userId, id: { in: categoryIds } },
					select: { id: true, name: true }
				})
			: []
		const idToName = new Map(categories.map(c => [c.id, c.name]))
		const grouped = new Map<
			string,
			{
				categoryId: string | null
				categoryName: string
				sum: number
				descriptionSums: Map<string, number>
			}
		>()
		for (const tx of txs) {
			const categoryName =
				(tx.categoryId ? idToName.get(tx.categoryId) : null) ??
				tx.category ??
				'📦Другое'
			const key = tx.categoryId
				? `id:${tx.categoryId}`
				: `name:${categoryName.toLowerCase()}`
			if (!grouped.has(key)) {
				grouped.set(key, {
					categoryId: tx.categoryId ?? null,
					categoryName,
					sum: 0,
					descriptionSums: new Map<string, number>()
				})
			}
			const current = grouped.get(key)!
			const { amount, currency } = this.pickTxAmount(tx)
			const inMain = await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				tx.transactionDate,
				this.pickAmountUsd(tx)
			)
			current.sum += inMain
			const label = tx.description?.trim() || '—'
			current.descriptionSums.set(
				label,
				(current.descriptionSums.get(label) ?? 0) + inMain
			)
		}
		const denom =
			beginningBalance != null && beginningBalance > 0 ? beginningBalance : 1
		return Array.from(grouped.values())
			.sort((a, b) => b.sum - a.sum)
			.slice(0, limit)
			.map(c => ({
				categoryId: c.categoryId,
				categoryName: c.categoryName,
				sum: c.sum,
				pct: (c.sum / denom) * 100,
				descriptionDetails: Array.from(c.descriptionSums.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 3)
					.map(([description, s]) => ({ description, sum: s }))
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
					amountDecimal: true,
					currency: true,
					convertedAmount: true,
					convertedAmountDecimal: true,
					convertToCurrency: true,
					transactionDate: true,
					amountUsd: true,
					amountUsdDecimal: true
				}
			})
			let sum = 0
			for (const t of txs) {
				const { amount, currency } = this.pickTxAmount(t)
				sum += await this.toMainCurrency(
					amount,
					currency,
					mainCurrency,
					t.transactionDate,
					this.pickAmountUsd(t)
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
					amountDecimal: true,
					currency: true,
					convertedAmount: true,
					convertedAmountDecimal: true,
					convertToCurrency: true,
					transactionDate: true,
					amountUsd: true,
					amountUsdDecimal: true
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
					amountDecimal: true,
					currency: true,
					convertedAmount: true,
					convertedAmountDecimal: true,
					convertToCurrency: true,
					transactionDate: true,
					amountUsd: true,
					amountUsdDecimal: true
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
					amountDecimal: true,
					currency: true,
					convertedAmount: true,
					convertedAmountDecimal: true,
					convertToCurrency: true,
					transactionDate: true,
					amountUsd: true,
					amountUsdDecimal: true
				}
			})
		])

		const sum = async (
			rows: {
				amount: number
				amountDecimal: unknown
				currency: string
				convertedAmount: number | null
				convertedAmountDecimal: unknown
				convertToCurrency: string | null
				transactionDate: Date
				amountUsd: number | null
				amountUsdDecimal: unknown
			}[]
		) => {
			let total = 0
			for (const r of rows) {
				const { amount, currency } = this.pickTxAmount(r)
				total += await this.toMainCurrency(
					amount,
					currency,
					mainCurrency,
					r.transactionDate,
					this.pickAmountUsd(r)
				)
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
				amountDecimal: true,
				currency: true,
				description: true,
				transactionDate: true,
				convertedAmount: true,
				convertedAmountDecimal: true,
				convertToCurrency: true,
				category: true,
				tagId: true,
				amountUsd: true,
				amountUsdDecimal: true
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
			const { amount, currency } = this.pickTxAmount(t)
			const amt = await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				t.transactionDate,
				this.pickAmountUsd(t)
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
		categoryIdOrName: string,
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
		const categoryFilter = await this.resolveCategoryWhere(userId, categoryIdOrName)

		const [total, txs] = await Promise.all([
			this.prisma.transaction.count({
				where: {
					userId,
					direction: 'expense',
					...categoryFilter,
					transactionDate: { gte: from, lte: to },
					...accountFilter
				}
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					...categoryFilter,
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: {
					id: true,
					amount: true,
					amountDecimal: true,
					currency: true,
					description: true,
					transactionDate: true,
					convertedAmount: true,
					convertedAmountDecimal: true,
					convertToCurrency: true,
					amountUsd: true,
					amountUsdDecimal: true
				},
				orderBy: { transactionDate: 'desc' },
				skip: page * pageSize,
				take: pageSize
			})
		])

		const transactions: AnomalyRow[] = []
		for (const t of txs) {
			const { amount, currency } = this.pickTxAmount(t)
			const amt = await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				t.transactionDate,
				this.pickAmountUsd(t)
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
					amountDecimal: true,
					currency: true,
					description: true,
					transactionDate: true,
					convertedAmount: true,
					convertedAmountDecimal: true,
					convertToCurrency: true,
					amountUsd: true,
					amountUsdDecimal: true
				},
				orderBy: { transactionDate: 'desc' },
				skip: page * pageSize,
				take: pageSize
			})
		])

		const transactions: AnomalyRow[] = []
		for (const t of txs) {
			const { amount, currency } = this.pickTxAmount(t)
			const amt = await this.toMainCurrency(
				amount,
				currency,
				mainCurrency,
				t.transactionDate,
				this.pickAmountUsd(t)
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
