import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

const CACHE_MS = 24 * 60 * 60 * 1000

@Injectable()
export class ExchangeService {
	private cache: { rates: Record<string, number>; fetchedAt: number } | null = null

	constructor(private readonly config: ConfigService) {}

	async getRates(): Promise<Record<string, number>> {
		if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_MS) {
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

	async convert(amount: number, fromCurrency: string, toCurrency: string): Promise<number> {
		if (fromCurrency === toCurrency) return amount
		const rates = await this.getRates()
		const from = rates[fromCurrency] ?? 1
		const to = rates[toCurrency] ?? 1
		return (amount / from) * to
	}
}
