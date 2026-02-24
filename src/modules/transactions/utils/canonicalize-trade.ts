export type TradeType = 'buy' | 'sell'

export interface TradeCanonicalInput {
	tradeType?: TradeType | null
	amount?: number | null
	currency?: string | null
	convertedAmount?: number | null
	convertToCurrency?: string | null
	tradeBaseCurrency?: string | null
	tradeBaseAmount?: number | null
	tradeQuoteCurrency?: string | null
	tradeQuoteAmount?: number | null
	executionPrice?: number | null
	tradeFeeCurrency?: string | null
	tradeFeeAmount?: number | null
}

export interface TradeCanonicalPayload {
	tradeType: TradeType
	amount: number | null
	currency: string | null
	convertedAmount: number | null
	convertToCurrency: string | null
	tradeBaseCurrency: string | null
	tradeBaseAmount: number | null
	tradeQuoteCurrency: string | null
	tradeQuoteAmount: number | null
	executionPrice: number | null
	tradeFeeCurrency: string | null
	tradeFeeAmount: number | null
}

const toPositiveNumber = (value: unknown): number | null => {
	const num = Number(value)
	if (!Number.isFinite(num)) return null
	const abs = Math.abs(num)
	return abs > 0 ? abs : null
}

const normalizeCurrency = (value: unknown): string | null => {
	const code = String(value ?? '')
		.trim()
		.toUpperCase()
	return code.length > 0 ? code : null
}

const pickPositive = (...values: unknown[]): number | null => {
	for (const value of values) {
		const n = toPositiveNumber(value)
		if (n != null) return n
	}
	return null
}

export function canonicalizeTradePayload(
	input: TradeCanonicalInput
): TradeCanonicalPayload | null {
	const tradeType = input.tradeType === 'buy' || input.tradeType === 'sell'
		? input.tradeType
		: null
	if (!tradeType) return null

	const amount = toPositiveNumber(input.amount)
	const convertedAmount = toPositiveNumber(input.convertedAmount)
	const currency = normalizeCurrency(input.currency)
	const convertToCurrency = normalizeCurrency(input.convertToCurrency)

	let tradeBaseCurrency = normalizeCurrency(input.tradeBaseCurrency)
	let tradeQuoteCurrency = normalizeCurrency(input.tradeQuoteCurrency)

	if (!tradeBaseCurrency) {
		tradeBaseCurrency = tradeType === 'buy' ? convertToCurrency : currency
	}
	if (!tradeQuoteCurrency) {
		tradeQuoteCurrency = tradeType === 'buy' ? currency : convertToCurrency
	}

	let tradeBaseAmount =
		tradeType === 'buy'
			? pickPositive(input.tradeBaseAmount, convertedAmount)
			: pickPositive(input.tradeBaseAmount, amount)
	let tradeQuoteAmount =
		tradeType === 'buy'
			? pickPositive(input.tradeQuoteAmount, amount)
			: pickPositive(input.tradeQuoteAmount, convertedAmount)

	let executionPrice = toPositiveNumber(input.executionPrice)
	if (executionPrice == null && tradeBaseAmount != null && tradeQuoteAmount != null) {
		executionPrice = Number((tradeQuoteAmount / tradeBaseAmount).toFixed(12))
	}
	if (tradeQuoteAmount == null && executionPrice != null && tradeBaseAmount != null) {
		tradeQuoteAmount = tradeBaseAmount * executionPrice
	}
	if (tradeBaseAmount == null && executionPrice != null && tradeQuoteAmount != null) {
		tradeBaseAmount = tradeQuoteAmount / executionPrice
	}

	const canonicalAmount = tradeType === 'buy' ? tradeQuoteAmount : tradeBaseAmount
	const canonicalCurrency = tradeType === 'buy' ? tradeQuoteCurrency : tradeBaseCurrency
	const canonicalConvertedAmount =
		tradeType === 'buy' ? tradeBaseAmount : tradeQuoteAmount
	const canonicalConvertToCurrency =
		tradeType === 'buy' ? tradeBaseCurrency : tradeQuoteCurrency

	const tradeFeeAmount = toPositiveNumber(input.tradeFeeAmount)
	const tradeFeeCurrency =
		normalizeCurrency(input.tradeFeeCurrency) ?? tradeQuoteCurrency

	return {
		tradeType,
		amount: canonicalAmount,
		currency: canonicalCurrency,
		convertedAmount: canonicalConvertedAmount,
		convertToCurrency: canonicalConvertToCurrency,
		tradeBaseCurrency,
		tradeBaseAmount,
		tradeQuoteCurrency,
		tradeQuoteAmount,
		executionPrice,
		tradeFeeCurrency,
		tradeFeeAmount
	}
}
