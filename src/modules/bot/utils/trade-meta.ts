export type TradeType = 'buy' | 'sell'

export type TradeMeta = {
	type: TradeType
	baseCurrency: string
	baseAmount: number
	quoteCurrency: string
	quoteAmount: number
	executionPrice: number
	feeCurrency?: string
	feeAmount?: number
}

const TRADE_META_PREFIX = '[[TRADE:'
const TRADE_META_SUFFIX = ']]'

function toNum(value: string): number | null {
	const n = Number(value)
	return Number.isFinite(n) ? n : null
}

function cleanCode(value: string): string {
	return String(value || '').toUpperCase().trim()
}

export function attachTradeMeta(rawText: string, meta: TradeMeta): string {
	const normalizedRaw = stripTradeMeta(rawText)
	const token =
		`${TRADE_META_PREFIX}` +
		`type=${meta.type};` +
		`base=${cleanCode(meta.baseCurrency)};` +
		`baseAmount=${meta.baseAmount};` +
		`quote=${cleanCode(meta.quoteCurrency)};` +
		`quoteAmount=${meta.quoteAmount};` +
		`price=${meta.executionPrice}` +
		(meta.feeAmount != null && Number.isFinite(meta.feeAmount) && meta.feeAmount > 0
			? `;fee=${meta.feeAmount};feeCurrency=${cleanCode(meta.feeCurrency ?? meta.quoteCurrency)}`
			: '') +
		`${TRADE_META_SUFFIX}`
	return `${normalizedRaw} ${token}`.trim()
}

export function stripTradeMeta(rawText: string): string {
	const source = String(rawText ?? '')
	return source.replace(/\[\[TRADE:[\s\S]*?\]\]/g, '').trim()
}

export function extractTradeMeta(rawText?: string | null): TradeMeta | null {
	const source = String(rawText ?? '')
	const match = source.match(/\[\[TRADE:([\s\S]*?)\]\]/)
	if (!match) return null
	const payload = match[1]
	const entries = payload
		.split(';')
		.map(s => s.trim())
		.filter(Boolean)
		.map(part => {
			const [k, ...rest] = part.split('=')
			return [k?.trim(), rest.join('=').trim()] as const
		})
	const map = new Map<string, string>(entries)
	const type = map.get('type')
	const baseCurrency = cleanCode(map.get('base') || '')
	const quoteCurrency = cleanCode(map.get('quote') || '')
	const baseAmount = toNum(map.get('baseAmount') || '')
	const quoteAmount = toNum(map.get('quoteAmount') || '')
	const executionPrice = toNum(map.get('price') || '')
	const feeAmount = toNum(map.get('fee') || '')
	const feeCurrency = cleanCode(map.get('feeCurrency') || '')
	if (
		(type !== 'buy' && type !== 'sell') ||
		!baseCurrency ||
		!quoteCurrency ||
		baseAmount == null ||
		quoteAmount == null ||
		executionPrice == null
	) {
		return null
	}
	return {
		type,
		baseCurrency,
		baseAmount,
		quoteCurrency,
		quoteAmount,
		executionPrice,
		...(feeAmount != null && feeAmount > 0 && feeCurrency
			? { feeAmount, feeCurrency }
			: {})
	}
}
