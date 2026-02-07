import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ExchangeService } from '../exchange/exchange.service'

export type AnalyticsPeriod = 7 | 30 | 90

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
}

function periodToDays(period: AnalyticsPeriod): number {
	return period
}

function dateRange(period: AnalyticsPeriod): { from: Date; to: Date } {
	const to = new Date()
	const from = new Date(to)
	from.setDate(from.getDate() - periodToDays(period))
	return { from, to }
}

function prevDateRange(period: AnalyticsPeriod): { from: Date; to: Date } {
	const to = new Date()
	to.setDate(to.getDate() - periodToDays(period))
	const from = new Date(to)
	from.setDate(from.getDate() - periodToDays(period))
	return { from, to }
}

@Injectable()
export class AnalyticsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly exchange: ExchangeService
	) {}

	private baseWhere(
		userId: string,
		filters: AnalyticsFilters
	) {
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
			where.category = { in: filters.categoryIds }
		}
		if (filters.tagIds?.length) {
			where.tagId = { in: filters.tagIds }
		}
		return { where, from, to }
	}

	private async toMainCurrency(
		amount: number,
		currency: string,
		mainCurrency: string
	): Promise<number> {
		return this.exchange.convert(amount, currency, mainCurrency)
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

		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

		const [incomeRows, expenseRows, incomePrevRows, expensePrevRows, assets] = await Promise.all([
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'income',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'income',
					transactionDate: { gte: prev.from, lte: prev.to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: prev.from, lte: prev.to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
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
			rows: { amount: number; currency: string; convertedAmount: number | null; convertToCurrency: string | null }[]
		) => {
			let total = 0
			for (const r of rows) {
				const amt = r.convertedAmount != null && r.convertToCurrency
					? r.convertedAmount
					: r.amount
				const cur = r.convertedAmount != null && r.convertToCurrency
					? r.convertToCurrency
					: r.currency
				total += await this.toMainCurrency(amt, cur, mainCurrency)
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
		const burnRate = period > 0 ? expenses / period : 0

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
		accountId?: string
	): Promise<CategorySum[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

		const rows = await this.prisma.transaction.groupBy({
			by: ['category'],
			where: {
				userId,
				direction: 'expense',
				transactionDate: { gte: from, lte: to },
				category: { not: null },
				...accountFilter
			},
			_sum: { amount: true },
			_count: true
		})

		let totalExpenses = 0
		const withConverted: { name: string; sum: number }[] = []
		for (const r of rows) {
			const txs = await this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: from, lte: to },
					category: r.category,
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			})
			let sum = 0
			for (const t of txs) {
				const amt = t.convertedAmount != null && t.convertToCurrency
					? t.convertedAmount
					: t.amount
				const cur = t.convertedAmount != null && t.convertToCurrency
					? t.convertToCurrency!
					: t.currency
				sum += await this.toMainCurrency(amt, cur, mainCurrency)
			}
			totalExpenses += sum
			withConverted.push({ name: r.category!, sum })
		}
		withConverted.sort((a, b) => b.sum - a.sum)
		const topNames = withConverted.slice(0, limit).map(c => c.name)
		const categories = await this.prisma.category.findMany({
			where: { userId, name: { in: topNames } },
			select: { id: true, name: true }
		})
		const nameToId = new Map(categories.map(c => [c.name, c.id]))
		return withConverted.slice(0, limit).map(c => ({
			categoryId: nameToId.get(c.name) ?? null,
			categoryName: c.name,
			sum: c.sum,
			pct: totalExpenses > 0 ? (c.sum / totalExpenses) * 100 : 0
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
		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

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
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			})
			let sum = 0
			for (const t of txs) {
				const amt = t.convertedAmount != null && t.convertToCurrency
					? t.convertedAmount
					: t.amount
				const cur = t.convertedAmount != null && t.convertToCurrency
					? t.convertToCurrency!
					: t.currency
				sum += await this.toMainCurrency(amt, cur, mainCurrency)
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
		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

		const [expenseRows, incomeRows, transferRows] = await Promise.all([
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'expense',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'income',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			}),
			this.prisma.transaction.findMany({
				where: {
					userId,
					direction: 'transfer',
					transactionDate: { gte: from, lte: to },
					...accountFilter
				},
				select: { amount: true, currency: true, convertedAmount: true, convertToCurrency: true }
			})
		])

		const sum = async (
			rows: { amount: number; currency: string; convertedAmount: number | null; convertToCurrency: string | null }[]
		) => {
			let total = 0
			for (const r of rows) {
				const amt = r.convertedAmount != null && r.convertToCurrency
					? r.convertedAmount
					: r.amount
				const cur = r.convertedAmount != null && r.convertToCurrency
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

	async getAnomalies(
		userId: string,
		period: AnalyticsPeriod,
		mainCurrency: string,
		threshold: number,
		accountId?: string
	): Promise<AnomalyRow[]> {
		const { from, to } = dateRange(period)
		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

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
				convertToCurrency: true
			},
			orderBy: { amount: 'desc' }
		})

		const result: AnomalyRow[] = []
		for (const t of txs) {
			const amt = t.convertedAmount != null && t.convertToCurrency
				? await this.toMainCurrency(t.convertedAmount, t.convertToCurrency, mainCurrency)
				: await this.toMainCurrency(t.amount, t.currency, mainCurrency)
			if (amt >= threshold) {
				result.push({
					transactionId: t.id,
					amount: amt,
					currency: mainCurrency,
					description: t.description,
					transactionDate: t.transactionDate
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
		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

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
			const amt = t.convertedAmount != null && t.convertToCurrency
				? await this.toMainCurrency(t.convertedAmount, t.convertToCurrency, mainCurrency)
				: await this.toMainCurrency(t.amount, t.currency, mainCurrency)
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
		const accountFilter = accountId ? { accountId } : { account: { userId, isHidden: false } }

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
			const amt = t.convertedAmount != null && t.convertToCurrency
				? await this.toMainCurrency(t.convertedAmount, t.convertToCurrency, mainCurrency)
				: await this.toMainCurrency(t.amount, t.currency, mainCurrency)
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
		return this.getSummary(
			userId,
			filters.period,
			mainCurrency,
			filters.accountId
		)
	}
}
