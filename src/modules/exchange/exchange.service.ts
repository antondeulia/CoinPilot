import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'

const FIAT_CACHE_MS = 24 * 60 * 60 * 1000
const CRYPTO_CACHE_MS = 3 * 60 * 60 * 1000
const COINGECKO_LIST_CACHE_MS = 24 * 60 * 60 * 1000

@Injectable()
export class ExchangeService {
	private readonly logger = new Logger(ExchangeService.name)
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
	private decimalsCache: { map: Map<string, number>; fetchedAt: number } | null = null

	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService
	) {}

	private toDayStartUtc(date: Date): Date {
		return new Date(
			Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)
		)
	}

	private normalizeRates(input: Record<string, unknown>): Record<string, number> {
		const out: Record<string, number> = { USD: 1 }
		for (const [k, v] of Object.entries(input)) {
			if (typeof v !== 'number' || Number.isNaN(v) || v <= 0) continue
			out[k.toUpperCase()] = v
		}
		return out
	}

	private async getLatestSnapshotRates(): Promise<Record<string, number> | null> {
		const prismaAny = this.prisma as any
		const row = await prismaAny.exchangeRateSnapshot?.findFirst?.({
			where: { baseCurrency: 'USD' },
			orderBy: { date: 'desc' }
		})
		if (!row?.rates || typeof row.rates !== 'object') return null
		return this.normalizeRates(row.rates as Record<string, unknown>)
	}

	private async upsertSnapshot(partialRates: Record<string, number>): Promise<void> {
		const prismaAny = this.prisma as any
		if (!prismaAny.exchangeRateSnapshot?.findUnique) return
		const date = this.toDayStartUtc(new Date())
		const key = { date_baseCurrency: { date, baseCurrency: 'USD' } }
		const existing = await prismaAny.exchangeRateSnapshot.findUnique({ where: key })
		const current = existing?.rates && typeof existing.rates === 'object'
			? this.normalizeRates(existing.rates as Record<string, unknown>)
			: { USD: 1 }
		const merged = { ...current, ...this.normalizeRates(partialRates) }
		if (existing) {
			await prismaAny.exchangeRateSnapshot.update({
				where: key,
				data: { rates: merged }
			})
			return
		}
		await prismaAny.exchangeRateSnapshot.create({
			data: {
				date,
				baseCurrency: 'USD',
				rates: merged
			}
		})
	}

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
		if (!key) {
			this.logger.warn('EXCHANGE_API_KEY is missing, using cache/snapshot fallback')
			return this.cache?.rates ?? (await this.getLatestSnapshotRates()) ?? { USD: 1 }
		}
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
			await this.upsertSnapshot(normalized)
			return normalized
		} catch {
			return this.cache?.rates ?? (await this.getLatestSnapshotRates()) ?? { USD: 1 }
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
		if (Object.keys(prices).length === 0) {
			const snapshotRates = await this.getLatestSnapshotRates()
			if (snapshotRates) {
				for (const sym of knownCrypto) {
					const candidate = snapshotRates[sym]
					if (candidate != null && Number.isFinite(candidate) && candidate > 0) {
						prices[sym] = candidate
					}
				}
			}
		}
		if (Object.keys(prices).length > 0) {
			this.cryptoCache = { prices, fetchedAt: Date.now() }
			await this.upsertSnapshot(prices)
		}
		return this.cryptoCache?.prices ?? prices
	}

	@Cron('0 1 * * *')
	async refreshFiatRatesSnapshot(): Promise<void> {
		const rates = await this.getRates()
		await this.upsertSnapshot(rates)
	}

	@Cron('0 */3 * * *')
	async refreshCryptoRatesSnapshot(): Promise<void> {
		const prices = await this.getCryptoRates()
		if (Object.keys(prices).length === 0) return
		await this.upsertSnapshot(prices)
	}

	async getHistoricalRate(
		date: Date,
		fromCurrency: string,
		toCurrency: string
	): Promise<number | null> {
		const from = (fromCurrency || '').toUpperCase()
		const to = (toCurrency || '').toUpperCase()
		if (from === to) return 1
		const known = await this.getKnownCurrencies()
		const fromKnown = known.fiat.has(from) || known.crypto.has(from)
		const toKnown = known.fiat.has(to) || known.crypto.has(to)
		if (!fromKnown || !toKnown) return null
		const prismaAny = this.prisma as any
		const row = await prismaAny.exchangeRateSnapshot?.findFirst?.({
			where: {
				baseCurrency: 'USD',
				date: { lte: this.toDayStartUtc(date) }
			},
			orderBy: { date: 'desc' }
		})
		if (!row?.rates || typeof row.rates !== 'object') return null
		const rates = this.normalizeRates(row.rates as Record<string, unknown>)
		const fromFiat = known.fiat.has(from)
		const toFiat = known.fiat.has(to)
		let usdValueForOneUnit: number
		if (fromFiat) {
			const rate = rates[from]
			if (rate == null) return null
			usdValueForOneUnit = 1 / rate
		} else {
			const price = rates[from]
			if (price == null) return null
			usdValueForOneUnit = price
		}
		let targetValueForOneUnit: number
		if (toFiat) {
			const rate = rates[to]
			if (rate == null) return null
			targetValueForOneUnit = usdValueForOneUnit * rate
		} else {
			const price = rates[to]
			if (price == null) return null
			targetValueForOneUnit = usdValueForOneUnit / price
		}
		return targetValueForOneUnit
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

	async getCurrencyDecimals(code: string): Promise<number> {
		const upper = (code || '').toUpperCase()
		if (!upper) return 2
		if (
			this.decimalsCache &&
			Date.now() - this.decimalsCache.fetchedAt < 60 * 60 * 1000
		) {
			return this.decimalsCache.map.get(upper) ?? 2
		}
		const rows = await this.prisma.currency.findMany({
			select: { code: true, decimals: true, type: true }
		})
		const map = new Map<string, number>()
		for (const row of rows) {
			const type = String(row.type || '').toLowerCase()
			const fallback = type === 'crypto' ? 18 : 2
			const safe = Number.isFinite(row.decimals)
				? Math.max(0, Math.min(18, row.decimals))
				: fallback
			map.set(row.code.toUpperCase(), safe)
		}
		this.decimalsCache = { map, fetchedAt: Date.now() }
		return map.get(upper) ?? 2
	}

	async roundByCurrency(amount: number, currencyCode: string): Promise<number> {
		if (!Number.isFinite(amount)) return amount
		const decimals = await this.getCurrencyDecimals(currencyCode)
		return Number(amount.toFixed(decimals))
	}
}
