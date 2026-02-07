export function formatAmount(amount: number, currency: string): string {
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
		USDT: '₮'
	}
	return map[currency] ?? currency
}

export function formatAccountName(name: string, isDefault: boolean): string {
	return isDefault ? `${name} (Основной)` : name
}

