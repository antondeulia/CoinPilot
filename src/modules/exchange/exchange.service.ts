import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'

const FIAT_CACHE_MS = 24 * 60 * 60 * 1000
const CRYPTO_CACHE_MS = 3 * 60 * 60 * 1000
const COINGECKO_LIST_CACHE_MS = 24 * 60 * 60 * 1000

@Injectable()
export class ExchangeService {
	private cache: { rates: Record<string, number>; fetchedAt: number } | null = null
	private cryptoCache: {
		prices: Record<string, number>
		fetchedAt: number
	} | null = null
	private currencyCache: {
		fiat: Set<string>
		crypto: Set<string>
		fetchedAt: number
	} | null = null
	private coingeckoIds: Record<string, string> = {}
	private coingeckoListFetchedAt = 0

	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService
	) {}

	/** Коды валют из БД (только они участвуют в конвертации). */
	async getKnownCurrencies(): Promise<{
		fiat: Set<string>
		crypto: Set<string>
	}> {
		if (
			this.currencyCache &&
			Date.now() - this.currencyCache.fetchedAt < 60 * 60 * 1000
		) {
			return {
				fiat: this.currencyCache.fiat,
				crypto: this.currencyCache.crypto
			}
		}
		const rows = await this.prisma.currency.findMany({
			select: { code: true, type: true }
		})
		const fiat = new Set<string>()
		const crypto = new Set<string>()
		for (const r of rows) {
			const code = r.code.toUpperCase()
			if (r.type === 'fiat') fiat.add(code)
			else crypto.add(code)
		}
		this.currencyCache = { fiat, crypto, fetchedAt: Date.now() }
		return { fiat, crypto }
	}

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
			const normalized: Record<string, number> = {}
			for (const [k, v] of Object.entries(rates)) {
				normalized[k.toUpperCase()] = v as number
			}
			this.cache = { rates: normalized, fetchedAt: Date.now() }
			return normalized
		} catch {
			return this.cache?.rates ?? { USD: 1 }
		}
	}

	/** Курсы крипты через CoinMarketCap (один символ = одна монета по капитализации). */
	private async getCryptoRatesFromCMC(): Promise<Record<string, number> | null> {
		const key = this.config.get<string>('COINMARKETCAP_API_KEY')
		if (!key) return null
		try {
			const res = await fetch(
				'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=500',
				{ headers: { 'X-CMC_PRO_API_KEY': key } }
			)
			const data = await res.json()
			const list = data?.data ?? []
			const prices: Record<string, number> = {}
			for (const item of list) {
				const symbol = item?.symbol
				const price = item?.quote?.USD?.price
				if (symbol != null && typeof price === 'number') {
					prices[(symbol as string).toUpperCase()] = price
				}
			}
			return Object.keys(prices).length > 0 ? prices : null
		} catch {
			return null
		}
	}

	/** CoinGecko: маппинг symbol → id по /coins/markets (топ по капитализации, без дубликатов по символу). */
	private async getCoingeckoIdsFromMarkets(): Promise<Record<string, string>> {
		if (Date.now() - this.coingeckoListFetchedAt < COINGECKO_LIST_CACHE_MS) {
			return this.coingeckoIds
		}
		try {
			const map: Record<string, string> = {}
			for (let page = 1; page <= 2; page++) {
				const res = await fetch(
					`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`
				)
				const list = (await res.json()) as { id: string; symbol: string }[]
				for (const c of list ?? []) {
					const sym = (c.symbol || '').toUpperCase()
					if (!sym || map[sym]) continue
					map[sym] = c.id
				}
			}
			this.coingeckoIds = map
			this.coingeckoListFetchedAt = Date.now()
			return map
		} catch {
			return this.coingeckoIds
		}
	}

	async getCryptoRates(): Promise<Record<string, number>> {
		if (
			this.cryptoCache &&
			Date.now() - this.cryptoCache.fetchedAt < CRYPTO_CACHE_MS
		) {
			return this.cryptoCache.prices
		}
		const { crypto: knownCrypto } = await this.getKnownCurrencies()
		if (knownCrypto.size === 0) {
			this.cryptoCache = { prices: {}, fetchedAt: Date.now() }
			return {}
		}

		let prices: Record<string, number> = {}
		const cmc = await this.getCryptoRatesFromCMC()
		if (cmc) {
			for (const sym of knownCrypto) {
				if (cmc[sym] != null) prices[sym] = cmc[sym]
			}
		}
		if (Object.keys(prices).length === 0) {
			const idsMap = await this.getCoingeckoIdsFromMarkets()
			const symbols = Array.from(knownCrypto).filter(s => idsMap[s])
			const batchSize = 250
			for (let i = 0; i < symbols.length; i += batchSize) {
				const batchSymbols = symbols.slice(i, i + batchSize)
				const batchIds = batchSymbols.map(s => idsMap[s]).filter(Boolean)
				if (batchIds.length === 0) continue
				try {
					const url = `https://api.coingecko.com/api/v3/simple/price?ids=${batchIds.join(',')}&vs_currencies=usd`
					const res = await fetch(url)
					const data = (await res.json()) as Record<string, { usd?: number }>
					for (const sym of batchSymbols) {
						const id = idsMap[sym]
						if (id && data[id]?.usd != null) prices[sym] = data[id].usd
					}
				} catch {
					// keep previous
				}
			}
		}
		if (Object.keys(prices).length > 0) {
			this.cryptoCache = { prices, fetchedAt: Date.now() }
		}
		return this.cryptoCache?.prices ?? prices
	}

	/** Конвертация. null = валюта неизвестна или нет курса — не учитывать в итогах. */
	async convert(
		amount: number,
		fromCurrency: string,
		toCurrency: string
	): Promise<number | null> {
		const from = (fromCurrency || '').toUpperCase()
		const to = (toCurrency || '').toUpperCase()
		if (from === to) return amount
		const known = await this.getKnownCurrencies()
		const fromKnown = known.fiat.has(from) || known.crypto.has(from)
		const toKnown = known.fiat.has(to) || known.crypto.has(to)
		if (!fromKnown || !toKnown) return null
		const fromFiat = known.fiat.has(from)
		const toFiat = known.fiat.has(to)
		let usdValue: number
		if (fromFiat) {
			const rates = await this.getRates()
			const rate = rates[from]
			if (rate == null) return null
			usdValue = amount / rate
		} else {
			const crypto = await this.getCryptoRates()
			const price = crypto[from]
			if (price == null) return null
			usdValue = amount * price
		}
		if (toFiat) {
			const rates = await this.getRates()
			const rate = rates[to]
			if (rate == null) return null
			return usdValue * rate
		} else {
			const crypto = await this.getCryptoRates()
			const price = crypto[to]
			if (price == null) return null
			return usdValue / price
		}
	}

	/** Тип валюты из БД (для фиат/крипто в отчётах). */
	async isCryptoByCode(code: string): Promise<boolean> {
		const known = await this.getKnownCurrencies()
		return known.crypto.has((code || '').toUpperCase())
	}
}
