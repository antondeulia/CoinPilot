import { LlmTransaction } from '../../../modules/llm/schemas/transaction.schema'
import { getCurrencySymbol, formatAccountName } from '../../../utils/format'
import { formatTransactionDate } from '../../../utils/date'

type NumericLike =
	| number
	| string
	| { toNumber?: () => number; valueOf?: () => unknown }
	| null
	| undefined

type ExactNumericLike =
	| number
	| string
	| { toNumber?: () => number; toString?: () => string; valueOf?: () => unknown }
	| null
	| undefined

function toFiniteNumber(value: NumericLike): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null
	}
	if (typeof value === 'string') {
		const parsed = Number(value.replace(',', '.'))
		return Number.isFinite(parsed) ? parsed : null
	}
	if (value && typeof value === 'object') {
		const withToNumber = value as { toNumber?: () => number; valueOf?: () => unknown }
		if (typeof withToNumber.toNumber === 'function') {
			const parsed = withToNumber.toNumber()
			return Number.isFinite(parsed) ? parsed : null
		}
		const primitive = withToNumber.valueOf?.()
		if (typeof primitive === 'number' && Number.isFinite(primitive)) {
			return primitive
		}
		if (typeof primitive === 'string') {
			const parsed = Number(primitive.replace(',', '.'))
			return Number.isFinite(parsed) ? parsed : null
		}
	}
	return null
}

function toExactNumericString(value: ExactNumericLike): string | null {
	if (value == null) return null
	if (typeof value === 'string') {
		const cleaned = value.replace(/\s+/g, '').replace(',', '.').trim()
		if (!cleaned) return null
		if (/^-?\d+(?:\.\d+)?$/u.test(cleaned)) return cleaned
		const parsed = Number(cleaned)
		return Number.isFinite(parsed) ? parsed.toString() : null
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value.toString() : null
	}
	if (typeof value === 'object') {
		const withFns = value as {
			toNumber?: () => number
			toString?: () => string
			valueOf?: () => unknown
		}
		if (typeof withFns.toString === 'function') {
			const raw = withFns.toString()
			if (raw && raw !== '[object Object]') {
				const cleaned = raw.replace(/\s+/g, '').replace(',', '.').trim()
				if (/^-?\d+(?:\.\d+)?$/u.test(cleaned)) return cleaned
			}
		}
		if (typeof withFns.toNumber === 'function') {
			const parsed = withFns.toNumber()
			if (Number.isFinite(parsed)) return parsed.toString()
		}
		const primitive = withFns.valueOf?.()
		if (typeof primitive === 'number' && Number.isFinite(primitive)) {
			return primitive.toString()
		}
		if (typeof primitive === 'string') {
			const cleaned = primitive.replace(/\s+/g, '').replace(',', '.').trim()
			if (/^-?\d+(?:\.\d+)?$/u.test(cleaned)) return cleaned
		}
	}
	return null
}

function formatExactNumber(value: ExactNumericLike, forceAbs = false): string {
	const raw = toExactNumericString(value)
	if (!raw) return '—'
	let normalized = raw
	if (/e/iu.test(normalized)) {
		const n = Number(normalized)
		if (!Number.isFinite(n)) return '—'
		normalized = n.toLocaleString('en-US', {
			useGrouping: false,
			maximumFractionDigits: 18
		})
	}
	const isNegative = normalized.startsWith('-')
	if (isNegative) normalized = normalized.slice(1)
	let [intPart = '0', fracPart = ''] = normalized.split('.')
	intPart = intPart.replace(/^0+(?=\d)/, '')
	const groupedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
	const decimalPart = fracPart ? `,${fracPart}` : ''
	const sign = !forceAbs && isNegative ? '-' : ''
	return `${sign}${groupedInt}${decimalPart}`
}

function formatExactAmount(
	value: ExactNumericLike,
	currency: string,
	forceAbs = false
): string {
	return `${formatExactNumber(value, forceAbs)} ${getCurrencySymbol(currency)}`
}

function formatDirection(direction: LlmTransaction['direction']) {
	if (direction === 'expense') return '🔴 Расход'
	if (direction === 'income') return '🟢 Доход'
	if (direction === 'transfer') return '🔄 Перевод'
	return '—'
}

function formatTradeDirection(type?: 'buy' | 'sell') {
	if (type === 'buy') return '📥 Покупка'
	if (type === 'sell') return '📤 Продажа'
	return null
}

function normalizeDescriptionKey(value?: string | null): string {
	return String(value ?? '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '')
		.trim()
}

function isGenericTradeDescription(
	value?: string | null,
	baseCurrency?: string,
	quoteCurrency?: string
): boolean {
	const key = normalizeDescriptionKey(value)
	if (!key) return true
	const baseKey = normalizeDescriptionKey(baseCurrency)
	const quoteKey = normalizeDescriptionKey(quoteCurrency)
	if (baseKey && key === baseKey) return true
	if (quoteKey && key === quoteKey) return true
	return (
		key === 'ордер' ||
		key === 'order' ||
		key === 'трейд' ||
		key === 'trade' ||
		key === 'покупка' ||
		key === 'продажа' ||
		key === 'transaction' ||
		key === 'транзакция' ||
		key === 'операция'
	)
}

export function renderConfirmMessage(
	tx: LlmTransaction,
	index?: number,
	total?: number,
	defaultAccountId?: string,
	tagInfo?: { name: string; isNew: boolean },
	title: string = 'Предпросмотр операции'
) {
	const draft = tx as any
	const tradeType = (draft.tradeType as 'buy' | 'sell' | undefined) ?? undefined
	const tradeDirection = formatTradeDirection(tradeType)
	const tagName = tagInfo?.name ?? draft?.tagName ?? ''
	const tagIsNew = tagInfo?.isNew ?? draft?.tagIsNew ?? false
	const tagLine =
		tagName.length > 0
			? `Тег:\n<blockquote>${tagName}${tagIsNew ? ' (новый)' : ''}</blockquote>`
			: 'Тег: -'
	const amountValue = toFiniteNumber((draft as any).amount ?? tx.amount)
	const convertedValue = toFiniteNumber(tx.convertedAmount as NumericLike)
	const amountText =
		amountValue != null && tx.currency
			? formatExactAmount((draft as any).amount ?? tx.amount ?? amountValue, tx.currency, true)
			: '—'
	const signPrefix =
		tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : ''
	const isDeletedCurrency = !!(draft as any).currencyDeleted

	const date = tx.transactionDate ? new Date(tx.transactionDate) : new Date()
	const dateText = formatTransactionDate(date)
	const headerIndex =
		typeof index === 'number' && typeof total === 'number'
			? ` ${index + 1}/${total}`
			: ''

	let amountLine = `Сумма: ${signPrefix}${amountText}`
	if (isDeletedCurrency) {
		amountLine = `Сумма: <s>${signPrefix}${amountText}</s> <code>deleted</code>`
	}
	if (
		amountValue != null &&
		tx.currency &&
		tx.convertToCurrency &&
		convertedValue != null &&
		tx.currency !== tx.convertToCurrency &&
		!isDeletedCurrency
	) {
		const convertedStr = formatExactAmount(
			tx.convertedAmount ?? convertedValue ?? 0,
			tx.convertToCurrency,
			true
		)
		amountLine = `Сумма: ${signPrefix}${amountText} (→ ${convertedStr})`
	}
	const executionPrice = toFiniteNumber(draft.executionPrice as NumericLike)
	let tradeBaseCurrency = String(draft.tradeBaseCurrency ?? '').toUpperCase()
	let tradeQuoteCurrency = String(draft.tradeQuoteCurrency ?? '').toUpperCase()
	let tradeBaseAmount = toFiniteNumber(draft.tradeBaseAmount as NumericLike)
	let tradeQuoteAmount = toFiniteNumber(draft.tradeQuoteAmount as NumericLike)
	if (tradeType) {
		if (!tradeBaseCurrency) {
			tradeBaseCurrency = String(
				(tradeType === 'buy' ? tx.convertToCurrency : tx.currency) ?? ''
			).toUpperCase()
		}
		if (!tradeQuoteCurrency) {
			tradeQuoteCurrency = String(
				(tradeType === 'buy' ? tx.currency : tx.convertToCurrency) ?? ''
			).toUpperCase()
		}
		if (tradeBaseAmount == null) {
			tradeBaseAmount =
				tradeType === 'buy' ? convertedValue ?? amountValue : amountValue ?? convertedValue
		}
		if (tradeQuoteAmount == null) {
			tradeQuoteAmount =
				tradeType === 'buy' ? amountValue ?? convertedValue : convertedValue ?? amountValue
		}
		if (
			tradeBaseAmount != null &&
			tradeBaseAmount > 0 &&
			(tradeQuoteAmount == null || tradeQuoteAmount <= 0) &&
			executionPrice != null &&
			executionPrice > 0
		) {
			tradeQuoteAmount = tradeBaseAmount * executionPrice
		}
	}
	if (
		tradeType &&
		tradeBaseCurrency &&
		tradeQuoteCurrency &&
		tradeBaseAmount != null &&
		tradeQuoteAmount != null
	) {
		const quoteLine = formatExactAmount(
			draft.tradeQuoteAmount ?? tradeQuoteAmount,
			tradeQuoteCurrency,
			true
		)
		const baseExact = formatExactAmount(
			draft.tradeBaseAmount ?? tradeBaseAmount,
			tradeBaseCurrency,
			true
		)
		const quoteSigned = tradeType === 'buy' ? '-' : '+'
		const baseSigned = tradeType === 'buy' ? '+' : '-'
		amountLine = `Сумма: ${baseSigned}${baseExact} (${quoteSigned}${quoteLine})`
	} else if (tradeType && tradeBaseCurrency && tradeBaseAmount != null) {
		const baseLine = formatExactAmount(
			draft.tradeBaseAmount ?? tradeBaseAmount,
			tradeBaseCurrency,
			true
		)
		const baseSigned = tradeType === 'buy' ? '+' : '-'
		amountLine = `Сумма: ${baseSigned}${baseLine}`
	}

	const isTransfer = tx.direction === 'transfer'
	const isTrade = tradeType === 'buy' || tradeType === 'sell'
	const pairLine =
		isTrade && tradeBaseCurrency && tradeQuoteCurrency
			? `Пара: ${tradeBaseCurrency}/${tradeQuoteCurrency}\n`
			: ''
	const categoryLine = isTransfer || isTrade ? '' : `Категория: ${tx.category ?? '—'}\n`
	const targetAccountName =
		(draft.toAccount as string) ??
		((draft.toAccountId as string | undefined) ? 'Вне Wallet' : '—')
	const targetAccountLine = isTransfer && !isTrade
		? `На счёт: ${formatAccountName(targetAccountName, false)}\n`
		: ''
	const executionPriceLine =
		isTrade && executionPrice != null
			? `Ср. цена выполнения: ${formatExactNumber(
					draft.executionPrice ?? executionPrice,
					true
				)}\n`
			: ''
	const tradeFeeAmount = toFiniteNumber(draft.tradeFeeAmount as NumericLike)
	const tradeFeeCurrency = String(
		draft.tradeFeeCurrency ?? tradeQuoteCurrency ?? ''
	).toUpperCase()
	const tradeFeeLine =
		isTrade && tradeFeeAmount != null && tradeFeeAmount > 0 && tradeFeeCurrency
			? `Торговая комиссия: ${formatExactAmount(
					draft.tradeFeeAmount ?? tradeFeeAmount,
					tradeFeeCurrency,
					true
				)}\n`
			: isTrade
				? 'Торговая комиссия: не указано\n'
				: ''
	const descriptionLine = isTrade
		? isGenericTradeDescription(tx.description, tradeBaseCurrency, tradeQuoteCurrency)
			? 'Ордер'
			: (tx.description ?? 'Ордер')
		: (tx.description ?? '—')
	const balanceAfterLine = draft.balanceAfterText
		? `\n<code>После операции баланс счёта: ${draft.balanceAfterText}</code>`
		: ''

	return `
📄 <b>${title}${headerIndex}</b>

${tradeDirection ?? formatDirection(tx.direction)}
${descriptionLine}

${amountLine}
${pairLine}${executionPriceLine}${tradeFeeLine}Счёт: ${formatAccountName(tx.account ?? '—', tx.accountId === defaultAccountId)}
${targetAccountLine}Дата: ${dateText}
${categoryLine}${tagLine}
${balanceAfterLine}`.trim()
}
