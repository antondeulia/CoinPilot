export function formatCryptoAmount(amount: number): string {
	const s = amount.toLocaleString('en-US', {
		minimumFractionDigits: 0,
		maximumFractionDigits: 8
	})
	const trimmed = s.replace(/\.?0+$/, '')
	if (trimmed.includes('.')) return trimmed
	return amount.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'ETC', 'XLM', 'BCH', 'APT', 'ARB', 'OP', 'INJ', 'TIA', 'SEI', 'SUI', 'NEAR', 'FIL', 'IMX', 'RUNE', 'STX', 'AAVE', 'MKR', 'CRV', 'SNX'])

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

