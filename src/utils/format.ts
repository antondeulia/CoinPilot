export function formatCryptoAmount(amount: number): string {
	const s = amount.toLocaleString('en-US', {
		minimumFractionDigits: 0,
		maximumFractionDigits: 8
	})
	const trimmed = s.replace(/\.?0+$/, '')
	if (trimmed.includes('.')) return trimmed
	return amount.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
}

const CRYPTO_SYMBOLS = new Set([
	'BTC',
	'ETH',
	'USDT',
	'USDC',
	'BNB',
	'SOL',
	'XRP',
	'ADA',
	'DOGE',
	'AVAX',
	'DOT',
	'MATIC',
	'LINK',
	'UNI',
	'ATOM',
	'LTC',
	'ETC',
	'XLM',
	'BCH',
	'APT',
	'ARB',
	'OP',
	'INJ',
	'TIA',
	'SEI',
	'SUI',
	'NEAR',
	'FIL',
	'IMX',
	'RUNE',
	'STX',
	'AAVE',
	'MKR',
	'CRV',
	'SNX'
])

export function isCryptoCurrency(currency: string): boolean {
	return CRYPTO_SYMBOLS.has((currency || '').toUpperCase())
}

export function formatAmount(amount: number, currency: string): string {
	if (isCryptoCurrency(currency)) {
		return `${formatCryptoAmount(amount)} ${getCurrencySymbol(currency)}`
	}
	const formatted = amount.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
	return `${formatted} ${getCurrencySymbol(currency)}`
}

export interface CurrencyPrecisionMeta {
	type?: string | null
	decimals?: number | null
}

export function getCurrencyFractionDigits(
	currency: string,
	meta?: CurrencyPrecisionMeta
): number {
	const type = String(meta?.type ?? '').toLowerCase()
	if (type === 'fiat') return 2
	if (type === 'crypto') {
		const dec = Number(meta?.decimals ?? 18)
		if (Number.isFinite(dec) && dec > 0) return Math.min(18, Math.trunc(dec))
		return 18
	}
	if (isCryptoCurrency(currency)) return 18
	return 2
}

export function roundByCurrencyPolicy(
	amount: number,
	currency: string,
	meta?: CurrencyPrecisionMeta
): number {
	const digits = getCurrencyFractionDigits(currency, meta)
	if (!Number.isFinite(amount)) return 0
	return Number(amount.toFixed(digits))
}

export function formatByCurrencyPolicy(
	amount: number,
	currency: string,
	meta?: CurrencyPrecisionMeta,
	options?: { withSymbol?: boolean; locale?: string }
): string {
	const digits = getCurrencyFractionDigits(currency, meta)
	const locale = options?.locale ?? 'ru-RU'
	const value = Number.isFinite(amount)
		? amount.toLocaleString(locale, {
				minimumFractionDigits: 0,
				maximumFractionDigits: digits
			})
		: '0'
	return options?.withSymbol === false
		? value
		: `${value} ${getCurrencySymbol(currency)}`
}

function groupIntegerPart(raw: string): string {
	return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function normalizeRawNumeric(value: number | string): string {
	const raw = String(value ?? '').trim()
	if (!raw) return '0'
	if (/e/i.test(raw)) {
		const n = Number(raw)
		if (!Number.isFinite(n)) return '0'
		return n.toLocaleString('en-US', {
			useGrouping: false,
			maximumFractionDigits: 20
		})
	}
	return raw.replace(',', '.')
}

export function formatExactAmount(
	value: number | string,
	currency: string,
	opts?: { maxFractionDigits?: number; trimTrailingZeros?: boolean }
): string {
	const normalized = normalizeRawNumeric(value)
	const negative = normalized.startsWith('-')
	const unsigned = negative ? normalized.slice(1) : normalized
	const [rawInt, rawFrac = ''] = unsigned.split('.')
	const intPart = groupIntegerPart(rawInt || '0')
	let fracPart = rawFrac
	if (typeof opts?.maxFractionDigits === 'number' && opts.maxFractionDigits >= 0) {
		fracPart = fracPart.slice(0, opts.maxFractionDigits)
	}
	if (opts?.trimTrailingZeros !== false) {
		fracPart = fracPart.replace(/0+$/, '')
	}
	const body = fracPart.length > 0 ? `${intPart},${fracPart}` : intPart
	return `${negative ? '-' : ''}${body} ${getCurrencySymbol(currency)}`
}

export function getCurrencySymbol(currency: string): string {
	const map: Record<string, string> = {
		EUR: '€',
		USD: '$',
		UAH: '₴',
		RUB: '₽',
		GBP: '£',
		PLN: 'zł',
		SEK: 'kr',
		USDT: '₮',
		USDC: '₮',
		BTC: '₿',
		ETH: 'Ξ'
	}
	return map[currency] ?? currency
}

export function formatAccountName(name: string, isDefault: boolean): string {
	return isDefault ? `${name} (Основной)` : name
}
