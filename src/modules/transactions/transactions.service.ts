import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { TransactionModel } from '../../generated/prisma/models'
import { ExchangeService } from '../exchange/exchange.service'
import { canonicalizeTradePayload } from './utils/canonicalize-trade'

@Injectable()
export class TransactionsService {
	private readonly logger = new Logger(TransactionsService.name)

	constructor(
		private prisma: PrismaService,
		private readonly exchangeService: ExchangeService
	) {}

	async create(params: {
		userId: string
		accountId: string
		amount: number
		currency: string
		direction: 'income' | 'expense' | 'transfer'
		tradeType?: 'buy' | 'sell'
		tradeBaseCurrency?: string
		tradeBaseAmount?: number
		tradeQuoteCurrency?: string
		tradeQuoteAmount?: number
		executionPrice?: number
		tradeFeeCurrency?: string
		tradeFeeAmount?: number
		fromAccountId?: string
		toAccountId?: string
		categoryId?: string
		category?: string
		description?: string
		rawText: string
		transactionDate?: Date
		tagId?: string
		convertedAmount?: number
		convertToCurrency?: string
	}) {
		let normalizedParams = this.mergeTradeCanonical(params)
		if (normalizedParams.tradeType === 'buy' || normalizedParams.tradeType === 'sell') {
			normalizedParams = {
				...normalizedParams,
				direction: 'transfer'
			}
		}
		this.assertTradeInvariants(normalizedParams)
		if (
			!Number.isFinite(normalizedParams.amount) ||
			Math.abs(normalizedParams.amount) <= 0
		) {
			throw new Error('Transaction amount must be greater than 0')
		}
		const categoryData = await this.resolveCategoryData(
			normalizedParams.userId,
			normalizedParams.categoryId,
			normalizedParams.category
		)
		const roundedConvertedAmount =
			normalizedParams.convertedAmount != null
				? await this.exchangeService.roundByCurrency(
						Math.abs(normalizedParams.convertedAmount),
						normalizedParams.convertToCurrency ?? normalizedParams.currency
					)
				: undefined
		const amountUsd = await this.exchangeService.convert(
			Math.abs(normalizedParams.amount),
			normalizedParams.currency,
			'USD'
		)
		const roundedTradeFeeAmount =
			normalizedParams.tradeFeeAmount != null
				? await this.exchangeService.roundByCurrency(
						Math.abs(normalizedParams.tradeFeeAmount),
						normalizedParams.tradeFeeCurrency ??
							normalizedParams.tradeQuoteCurrency ??
							normalizedParams.currency
					)
				: undefined
		const tx = await this.prisma.transaction.create({
			data: {
				...normalizedParams,
				amount: Math.abs(normalizedParams.amount),
				categoryId: categoryData.categoryId,
				category: categoryData.category,
				convertedAmount: roundedConvertedAmount,
				tradeFeeAmount: roundedTradeFeeAmount,
				amountUsd: amountUsd ?? undefined
			}
		})
		await this.applyBalanceEffect(tx)
		return tx
	}

	async applyBalanceEffect(tx: TransactionModel) {
		this.logTradeInvariantWarning(tx, 'apply')
		const useConverted = tx.convertedAmount != null && tx.convertToCurrency != null
		const amountToUse = useConverted
			? Number(tx.convertedAmount!)
			: Number(tx.amount)
		const currencyToUse = useConverted ? tx.convertToCurrency! : tx.currency

		if (tx.direction === 'expense') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, -amountToUse)
		} else if (tx.direction === 'income') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, amountToUse)
		} else if (tx.direction === 'transfer' && tx.toAccountId) {
			const fromId = tx.fromAccountId ?? tx.accountId
			await this.upsertAssetDelta(fromId, tx.currency, -Number(tx.amount))
			await this.upsertAssetDelta(tx.toAccountId, currencyToUse, amountToUse)
			const feeAmount = Number((tx as any).tradeFeeAmount ?? 0)
			const feeCurrency = String((tx as any).tradeFeeCurrency ?? '').toUpperCase()
			if (feeAmount > 0 && feeCurrency) {
				await this.upsertAssetDelta(fromId, feeCurrency, -feeAmount)
			}
		}
	}

	async reverseBalanceEffect(tx: TransactionModel) {
		this.logTradeInvariantWarning(tx, 'reverse')
		const useConverted = tx.convertedAmount != null && tx.convertToCurrency != null
		const amountToUse = useConverted
			? Number(tx.convertedAmount!)
			: Number(tx.amount)
		const currencyToUse = useConverted ? tx.convertToCurrency! : tx.currency

		if (tx.direction === 'expense') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, amountToUse)
		} else if (tx.direction === 'income') {
			await this.upsertAssetDelta(tx.accountId, currencyToUse, -amountToUse)
		} else if (tx.direction === 'transfer' && tx.toAccountId) {
			const fromId = tx.fromAccountId ?? tx.accountId
			await this.upsertAssetDelta(fromId, tx.currency, Number(tx.amount))
			await this.upsertAssetDelta(tx.toAccountId, currencyToUse, -amountToUse)
			const feeAmount = Number((tx as any).tradeFeeAmount ?? 0)
			const feeCurrency = String((tx as any).tradeFeeCurrency ?? '').toUpperCase()
			if (feeAmount > 0 && feeCurrency) {
				await this.upsertAssetDelta(fromId, feeCurrency, feeAmount)
			}
		}
	}

	async update(
		id: string,
		userId: string,
		params: {
			accountId?: string
			amount?: number
			currency?: string
			direction?: 'income' | 'expense' | 'transfer'
			tradeType?: 'buy' | 'sell' | null
			tradeBaseCurrency?: string | null
			tradeBaseAmount?: number | null
			tradeQuoteCurrency?: string | null
			tradeQuoteAmount?: number | null
			executionPrice?: number | null
			tradeFeeCurrency?: string | null
			tradeFeeAmount?: number | null
			categoryId?: string | null
			category?: string | null
			description?: string
			rawText?: string
			transactionDate?: Date
			tagId?: string | null
			convertedAmount?: number | null
			convertToCurrency?: string | null
			fromAccountId?: string | null
			toAccountId?: string | null
		}
	) {
		const existing = await this.prisma.transaction.findFirst({
			where: { id, userId }
		})
		if (!existing) return null
		let normalizedParams = { ...params }
		const mergedTradeType =
			params.tradeType === undefined ? existing.tradeType : params.tradeType
		const canonicalMerged = canonicalizeTradePayload({
			tradeType: mergedTradeType as 'buy' | 'sell' | null,
			amount: params.amount ?? Number(existing.amount),
			currency: params.currency ?? existing.currency,
			convertedAmount:
				params.convertedAmount ??
				(existing.convertedAmount != null
					? Number(existing.convertedAmount)
					: null),
			convertToCurrency: params.convertToCurrency ?? existing.convertToCurrency,
			tradeBaseCurrency: params.tradeBaseCurrency ?? existing.tradeBaseCurrency,
			tradeBaseAmount:
				params.tradeBaseAmount ??
				(existing.tradeBaseAmount != null ? Number(existing.tradeBaseAmount) : null),
			tradeQuoteCurrency: params.tradeQuoteCurrency ?? existing.tradeQuoteCurrency,
			tradeQuoteAmount:
				params.tradeQuoteAmount ??
				(existing.tradeQuoteAmount != null ? Number(existing.tradeQuoteAmount) : null),
			executionPrice:
				params.executionPrice ??
				(existing.executionPrice != null ? Number(existing.executionPrice) : null),
			tradeFeeCurrency: params.tradeFeeCurrency ?? existing.tradeFeeCurrency,
			tradeFeeAmount:
				params.tradeFeeAmount ??
				(existing.tradeFeeAmount != null ? Number(existing.tradeFeeAmount) : null)
		})
		if (canonicalMerged) {
			normalizedParams = {
				...normalizedParams,
				tradeType: canonicalMerged.tradeType,
				amount:
					canonicalMerged.amount ??
					normalizedParams.amount ??
					Number(existing.amount),
				currency:
					canonicalMerged.currency ??
					normalizedParams.currency ??
					existing.currency,
				convertedAmount:
					canonicalMerged.convertedAmount ??
					normalizedParams.convertedAmount ??
					(existing.convertedAmount != null
						? Number(existing.convertedAmount)
						: null),
				convertToCurrency:
					canonicalMerged.convertToCurrency ??
					normalizedParams.convertToCurrency ??
					existing.convertToCurrency,
				tradeBaseCurrency:
					canonicalMerged.tradeBaseCurrency ??
					normalizedParams.tradeBaseCurrency ??
					existing.tradeBaseCurrency,
				tradeBaseAmount:
					canonicalMerged.tradeBaseAmount ??
					normalizedParams.tradeBaseAmount ??
					(existing.tradeBaseAmount != null
						? Number(existing.tradeBaseAmount)
						: null),
				tradeQuoteCurrency:
					canonicalMerged.tradeQuoteCurrency ??
					normalizedParams.tradeQuoteCurrency ??
					existing.tradeQuoteCurrency,
				tradeQuoteAmount:
					canonicalMerged.tradeQuoteAmount ??
					normalizedParams.tradeQuoteAmount ??
					(existing.tradeQuoteAmount != null
						? Number(existing.tradeQuoteAmount)
						: null),
				executionPrice:
					canonicalMerged.executionPrice ??
					normalizedParams.executionPrice ??
					(existing.executionPrice != null
						? Number(existing.executionPrice)
						: null),
				tradeFeeCurrency:
					canonicalMerged.tradeFeeCurrency ??
					normalizedParams.tradeFeeCurrency ??
					existing.tradeFeeCurrency,
				tradeFeeAmount:
					canonicalMerged.tradeFeeAmount ??
					normalizedParams.tradeFeeAmount ??
					(existing.tradeFeeAmount != null
						? Number(existing.tradeFeeAmount)
						: null)
			}
		}
		const effectiveTradeType =
			normalizedParams.tradeType === undefined
				? (existing.tradeType as 'buy' | 'sell' | null)
				: normalizedParams.tradeType
		if (effectiveTradeType === 'buy' || effectiveTradeType === 'sell') {
			normalizedParams.direction = 'transfer'
		}
		this.assertTradeInvariants({
			tradeType: effectiveTradeType,
			direction:
				normalizedParams.direction ??
				(existing.direction as 'income' | 'expense' | 'transfer'),
			amount: normalizedParams.amount ?? Number(existing.amount),
			currency: normalizedParams.currency ?? existing.currency,
			convertedAmount:
				normalizedParams.convertedAmount ??
				(existing.convertedAmount != null
					? Number(existing.convertedAmount)
					: null),
			convertToCurrency:
				normalizedParams.convertToCurrency ?? existing.convertToCurrency,
			tradeBaseCurrency:
				normalizedParams.tradeBaseCurrency ?? existing.tradeBaseCurrency,
			tradeBaseAmount:
				normalizedParams.tradeBaseAmount ??
				(existing.tradeBaseAmount != null
					? Number(existing.tradeBaseAmount)
					: null),
			tradeQuoteCurrency:
				normalizedParams.tradeQuoteCurrency ?? existing.tradeQuoteCurrency,
			tradeQuoteAmount:
				normalizedParams.tradeQuoteAmount ??
				(existing.tradeQuoteAmount != null
					? Number(existing.tradeQuoteAmount)
					: null)
		})
		if (
			normalizedParams.amount != null &&
			(!Number.isFinite(normalizedParams.amount) ||
				Math.abs(normalizedParams.amount) <= 0)
		) {
			throw new Error('Transaction amount must be greater than 0')
		}
		await this.reverseBalanceEffect(existing as TransactionModel)
		const amountRaw =
			normalizedParams.amount != null
				? Math.abs(normalizedParams.amount)
				: Number(existing.amount)
		const currencyRaw = normalizedParams.currency ?? existing.currency
		const convertCurrencyRaw =
			normalizedParams.convertToCurrency ??
			existing.convertToCurrency ??
			normalizedParams.currency ??
			existing.currency
		const roundedConvertedAmount =
			normalizedParams.convertedAmount !== undefined
				? normalizedParams.convertedAmount != null
					? await this.exchangeService.roundByCurrency(
							Math.abs(normalizedParams.convertedAmount),
							convertCurrencyRaw
						)
					: null
				: undefined
		const amountUsd = await this.exchangeService.convert(amountRaw, currencyRaw, 'USD')
		const feeCurrencyRaw =
			normalizedParams.tradeFeeCurrency ??
			existing.tradeFeeCurrency ??
			normalizedParams.tradeQuoteCurrency ??
			existing.tradeQuoteCurrency ??
			normalizedParams.currency ??
			existing.currency
		const roundedTradeFeeAmount =
			normalizedParams.tradeFeeAmount !== undefined
				? normalizedParams.tradeFeeAmount != null
					? await this.exchangeService.roundByCurrency(
							Math.abs(normalizedParams.tradeFeeAmount),
							feeCurrencyRaw
						)
					: null
				: undefined
		const shouldResolveCategory =
			normalizedParams.categoryId !== undefined ||
			normalizedParams.category !== undefined
		const categoryData = shouldResolveCategory
			? await this.resolveCategoryData(
					userId,
					normalizedParams.categoryId,
					normalizedParams.category
				)
			: null
		const updated = await this.prisma.transaction.update({
			where: { id },
			data: {
				...(normalizedParams.accountId != null && {
					accountId: normalizedParams.accountId
				}),
				...(normalizedParams.amount != null && {
					amount: Math.abs(normalizedParams.amount)
				}),
				...(normalizedParams.currency != null && {
					currency: normalizedParams.currency
				}),
				...(normalizedParams.direction != null && {
					direction: normalizedParams.direction
				}),
				...(normalizedParams.tradeType !== undefined && {
					tradeType: normalizedParams.tradeType
				}),
				...(normalizedParams.tradeBaseCurrency !== undefined && {
					tradeBaseCurrency: normalizedParams.tradeBaseCurrency
				}),
				...(normalizedParams.tradeBaseAmount !== undefined && {
					tradeBaseAmount: normalizedParams.tradeBaseAmount
				}),
				...(normalizedParams.tradeQuoteCurrency !== undefined && {
					tradeQuoteCurrency: normalizedParams.tradeQuoteCurrency
				}),
				...(normalizedParams.tradeQuoteAmount !== undefined && {
					tradeQuoteAmount: normalizedParams.tradeQuoteAmount
				}),
				...(normalizedParams.executionPrice !== undefined && {
					executionPrice: normalizedParams.executionPrice
				}),
				...(normalizedParams.tradeFeeCurrency !== undefined && {
					tradeFeeCurrency: normalizedParams.tradeFeeCurrency
				}),
				...(normalizedParams.tradeFeeAmount !== undefined && {
					tradeFeeAmount: roundedTradeFeeAmount
				}),
				...(categoryData != null && {
					categoryId: categoryData.categoryId,
					category: categoryData.category
				}),
				...(normalizedParams.description != null && {
					description: normalizedParams.description
				}),
				...(normalizedParams.rawText != null && { rawText: normalizedParams.rawText }),
				...(normalizedParams.transactionDate != null && {
					transactionDate: normalizedParams.transactionDate
				}),
				...(normalizedParams.tagId !== undefined && {
					tagId: normalizedParams.tagId
				}),
				...(normalizedParams.convertedAmount !== undefined && {
					convertedAmount: roundedConvertedAmount
				}),
				...(normalizedParams.convertToCurrency !== undefined && {
					convertToCurrency: normalizedParams.convertToCurrency
				}),
				...(normalizedParams.fromAccountId !== undefined && {
					fromAccountId: normalizedParams.fromAccountId
				}),
				...(normalizedParams.toAccountId !== undefined && {
					toAccountId: normalizedParams.toAccountId
				}),
				amountUsd: amountUsd ?? null
			}
		})
		await this.applyBalanceEffect(updated as TransactionModel)
		return updated
	}

	async delete(id: string, userId: string) {
		const tx = await this.prisma.transaction.findFirst({
			where: { id, userId }
		})
		if (!tx) return null
		await this.reverseBalanceEffect(tx as TransactionModel)
		await this.prisma.transaction.delete({ where: { id } })
		return tx
	}

	private async upsertAssetDelta(accountId: string, currency: string, delta: number) {
		await this.prisma.accountAsset.upsert({
			where: {
				accountId_currency: { accountId, currency }
			},
			update: { amount: { increment: delta } },
			create: { accountId, currency, amount: delta }
		})
	}

	private async resolveCategoryData(
		userId: string,
		categoryId?: string | null,
		categoryName?: string | null
	): Promise<{ categoryId: string | null; category: string | null }> {
		const normalizeName = (value?: string | null): string | null => {
			const trimmed = (value ?? '').trim()
			return trimmed.length ? trimmed : null
		}

		if (categoryId === null) {
			return { categoryId: null, category: normalizeName(categoryName) }
		}

		if (categoryId) {
			const byId = await this.prisma.category.findFirst({
				where: { id: categoryId, userId },
				select: { id: true, name: true }
			})
			if (byId) {
				return { categoryId: byId.id, category: byId.name }
			}
		}

		const normalizedName = normalizeName(categoryName)
		if (!normalizedName) {
			return { categoryId: null, category: null }
		}

		const byName = await this.prisma.category.findFirst({
			where: { userId, name: normalizedName },
			select: { id: true, name: true }
		})
		if (byName) {
			return { categoryId: byName.id, category: byName.name }
		}

		return { categoryId: null, category: normalizedName }
	}

	private mergeTradeCanonical<T extends {
		tradeType?: 'buy' | 'sell'
		amount: number
		currency: string
		convertedAmount?: number
		convertToCurrency?: string
		tradeBaseCurrency?: string
		tradeBaseAmount?: number
		tradeQuoteCurrency?: string
		tradeQuoteAmount?: number
		executionPrice?: number
		tradeFeeCurrency?: string
		tradeFeeAmount?: number
	}>(params: T): T {
		const canonical = canonicalizeTradePayload(params)
		if (!canonical) return params
		return {
			...params,
			tradeType: canonical.tradeType,
			amount: canonical.amount ?? params.amount,
			currency: canonical.currency ?? params.currency,
			convertedAmount: canonical.convertedAmount ?? params.convertedAmount,
			convertToCurrency:
				canonical.convertToCurrency ?? params.convertToCurrency,
			tradeBaseCurrency:
				canonical.tradeBaseCurrency ?? params.tradeBaseCurrency,
			tradeBaseAmount: canonical.tradeBaseAmount ?? params.tradeBaseAmount,
			tradeQuoteCurrency:
				canonical.tradeQuoteCurrency ?? params.tradeQuoteCurrency,
			tradeQuoteAmount: canonical.tradeQuoteAmount ?? params.tradeQuoteAmount,
			executionPrice: canonical.executionPrice ?? params.executionPrice,
			tradeFeeCurrency:
				canonical.tradeFeeCurrency ?? params.tradeFeeCurrency,
			tradeFeeAmount: canonical.tradeFeeAmount ?? params.tradeFeeAmount
		}
	}

	private assertTradeInvariants(params: {
		tradeType?: 'buy' | 'sell' | null
		direction?: 'income' | 'expense' | 'transfer' | null
		amount?: number | null
		currency?: string | null
		convertedAmount?: number | null
		convertToCurrency?: string | null
		tradeBaseCurrency?: string | null
		tradeBaseAmount?: number | null
		tradeQuoteCurrency?: string | null
		tradeQuoteAmount?: number | null
	}) {
		const tradeType = params.tradeType
		if (tradeType !== 'buy' && tradeType !== 'sell') return
		if (params.direction && params.direction !== 'transfer') {
			throw new Error('Trade transaction direction must be transfer')
		}
		const amount = Number(params.amount)
		const convertedAmount = Number(params.convertedAmount)
		const hasAmount = Number.isFinite(amount) && Math.abs(amount) > 0
		const hasConverted =
			Number.isFinite(convertedAmount) && Math.abs(convertedAmount) > 0
		if (!hasAmount || !hasConverted) {
			throw new Error(
				'Trade transaction must include both debit and credit amounts'
			)
		}
		const currency = String(params.currency ?? '')
			.trim()
			.toUpperCase()
		const convertToCurrency = String(params.convertToCurrency ?? '')
			.trim()
			.toUpperCase()
		const baseCurrency = String(params.tradeBaseCurrency ?? '')
			.trim()
			.toUpperCase()
		const quoteCurrency = String(params.tradeQuoteCurrency ?? '')
			.trim()
			.toUpperCase()
		const baseAmount = Number(params.tradeBaseAmount)
		const quoteAmount = Number(params.tradeQuoteAmount)
		const hasBaseAmount = Number.isFinite(baseAmount) && Math.abs(baseAmount) > 0
		const hasQuoteAmount =
			Number.isFinite(quoteAmount) && Math.abs(quoteAmount) > 0
		if (!currency || !convertToCurrency || !baseCurrency || !quoteCurrency) {
			throw new Error('Trade transaction must include base/quote currencies')
		}
		if (!hasBaseAmount || !hasQuoteAmount) {
			throw new Error('Trade transaction must include base/quote amounts')
		}
		if (tradeType === 'buy') {
			if (currency !== quoteCurrency || convertToCurrency !== baseCurrency) {
				throw new Error('Trade buy payload is not canonical (quote->base)')
			}
			return
		}
		if (currency !== baseCurrency || convertToCurrency !== quoteCurrency) {
			throw new Error('Trade sell payload is not canonical (base->quote)')
		}
	}

	private logTradeInvariantWarning(
		tx: TransactionModel,
		stage: 'apply' | 'reverse'
	) {
		if (process.env.NODE_ENV === 'production') return
		const tradeType = (tx.tradeType as 'buy' | 'sell' | null) ?? null
		if (tradeType !== 'buy' && tradeType !== 'sell') return
		const hasBothSides =
			tx.convertedAmount != null &&
			!!tx.convertToCurrency &&
			Number(tx.amount) > 0 &&
			Number(tx.convertedAmount) > 0
		if (tx.direction !== 'transfer' || !tx.toAccountId || !hasBothSides) {
			this.logger.warn(
				`Trade invariant mismatch at ${stage}: tx=${tx.id} tradeType=${tradeType} direction=${tx.direction}`
			)
		}
	}
}
