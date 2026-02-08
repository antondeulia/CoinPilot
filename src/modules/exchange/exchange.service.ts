import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

const FIAT_CACHE_MS = 24 * 60 * 60 * 1000
const CRYPTO_CACHE_MS = 3 * 60 * 60 * 1000

const FIAT_SYMBOLS = new Set([
	'USD', 'EUR', 'UAH', 'RUB', 'GBP', 'PLN', 'SEK', 'NOK', 'DKK', 'CHF', 'JPY', 'CNY', 'CAD', 'AUD', 'CZK', 'BRL', 'INR', 'MXN', 'KRW'
])

@Injectable()
export class ExchangeService {
	private cache: { rates: Record<string, number>; fetchedAt: number } | null = null
	private cryptoCache: { prices: Record<string, number>; fetchedAt: number } | null = null

	constructor(private readonly config: ConfigService) {}

	async getRates(): Promise<Record<string, number>> {
		if (this.cache && Date.now() - this.cache.fetchedAt < FIAT_CACHE_MS) {
			return this.cache.rates
		}
		const key = this.config.get<string>('EXCHANGE_API_KEY')
		if (!key) return { USD: 1 }
		try {
			const res = await fetch(
				`https://v6.exchangerate-api.com/v6/${key}/latest/USD`
			)
			const data = await res.json()
			const rates = (data.conversion_rates || { USD: 1 }) as Record<string, number>
			this.cache = { rates, fetchedAt: Date.now() }
			return rates
		} catch {
			return this.cache?.rates ?? { USD: 1 }
		}
	}

	async getCryptoRates(): Promise<Record<string, number>> {
		if (this.cryptoCache && Date.now() - this.cryptoCache.fetchedAt < CRYPTO_CACHE_MS) {
			return this.cryptoCache.prices
		}
		const key = this.config.get<string>('COINMARKETCAP_API_KEY')
		if (!key) return this.cryptoCache?.prices ?? {}
		try {
			const res = await fetch(
				'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=500',
				{ headers: { 'X-CMC_PRO_API_KEY': key } }
			)
			const data = await res.json()
			const prices: Record<string, number> = {}
			const list = data?.data ?? []
			for (const item of list) {
				const symbol = item?.symbol
				const price = item?.quote?.USD?.price
				if (symbol != null && typeof price === 'number') prices[symbol] = price
			}
			if (Object.keys(prices).length > 0) {
				this.cryptoCache = { prices, fetchedAt: Date.now() }
			}
			return this.cryptoCache?.prices ?? prices
		} catch {
			return this.cryptoCache?.prices ?? {}
		}
	}

	private isFiat(symbol: string): boolean {
		return FIAT_SYMBOLS.has(symbol.toUpperCase())
	}

	async convert(amount: number, fromCurrency: string, toCurrency: string): Promise<number> {
		if (fromCurrency === toCurrency) return amount
		const fromFiat = this.isFiat(fromCurrency)
		const toFiat = this.isFiat(toCurrency)
		let usdValue: number
		if (fromFiat) {
			const rates = await this.getRates()
			const from = rates[fromCurrency] ?? 1
			usdValue = amount / from
		} else {
			const crypto = await this.getCryptoRates()
			const price = crypto[fromCurrency.toUpperCase()]
			if (price == null) return amount
			usdValue = amount * price
		}
		if (toFiat) {
			const rates = await this.getRates()
			const to = rates[toCurrency] ?? 1
			return usdValue * to
		} else {
			const crypto = await this.getCryptoRates()
			const price = crypto[toCurrency.toUpperCase()]
			if (price == null) return amount
			return usdValue / price
		}
	}
}
