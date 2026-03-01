export interface AmountCurrencyPair {
	amount: number
	currency: string
	precision?: number
}

export interface ExchangeIntent {
	sourceAmount: number | null
	sourceCurrency: string | null
	targetAmount: number | null
	targetCurrency: string | null
	explicitPair: boolean
}

export interface ExchangeAccountAsset {
	currency: string
	amount: number
}

export interface ExchangeAccountCandidate {
	id: string
	assets: ExchangeAccountAsset[]
}

export interface ExchangeAccountStats {
	usageCount: number
	lastUsedAtMs: number
}

const CURRENCY_ALIASES: Record<string, string> = {
	USDT: 'USDT',
	ТЕТЕР: 'USDT',
	TON: 'TON',
	ТОН: 'TON',
	USD: 'USD',
	$: 'USD',
	ДОЛ: 'USD',
	ДОЛЛ: 'USD',
	'ДОЛ.': 'USD',
	'ДОЛЛ.': 'USD',
	ДОЛЛАР: 'USD',
	ДОЛЛАРЫ: 'USD',
	ДОЛЛАРОВ: 'USD',
	ЮСД: 'USD',
	EUR: 'EUR',
	'€': 'EUR',
	ЕВРО: 'EUR',
	UAH: 'UAH',
	'₴': 'UAH',
	ГРН: 'UAH',
	ГРИВНА: 'UAH',
	ГРИВНЫ: 'UAH',
	RUB: 'RUB',
	RUR: 'RUB',
	'₽': 'RUB',
	РУБ: 'RUB',
	РУБЛЬ: 'RUB',
	РУБЛЯ: 'RUB',
	РУБЛЕЙ: 'RUB'
}

export function normalizeExchangeCurrency(raw: string): string {
	const compact = String(raw ?? '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '')
	if (!compact) return ''
	const alias = CURRENCY_ALIASES[compact]
	if (alias) return alias
	const token = compact.replace(/[^A-Z0-9$€₴₽]/g, '')
	return CURRENCY_ALIASES[token] ?? token
}

export function extractExchangeIntentFromText(
	text: string,
	pairs: AmountCurrencyPair[]
): ExchangeIntent | null {
	const source = String(text ?? '')
	if (!source.trim()) return null
	const connectorCandidates: { amount: number | null; currency: string }[] = []
	for (const match of source.matchAll(
		/(?:на|в|to|->|→)\s*(?:(\d+(?:[.,]\d+)?)\s*)?([A-Za-zА-Яа-яЁё$€₴₽]{2,16})/giu
	)) {
		const candidateCurrency = normalizeExchangeCurrency(match[2] ?? '')
		if (!candidateCurrency) continue
		const amountRaw = match[1]
		const parsedAmount =
			amountRaw != null && amountRaw !== ''
				? Number(String(amountRaw).replace(',', '.'))
				: null
		connectorCandidates.push({
			amount:
				parsedAmount != null && Number.isFinite(parsedAmount)
					? Math.abs(parsedAmount)
					: null,
			currency: candidateCurrency
		})
	}

	// "обмен 500 usd на 460 eur", "обмен 500 usd на eur"
	const explicit = source.match(
		/(?:обмен(?:ял[аи]?|ять)?|конверт(?:аци[яию]|ир(?:овал|овать)?)?|swap|exchange)\s*(?:[:\-])?\s*(\d+(?:[.,]\d+)?)\s*([A-Za-zА-Яа-яЁё$€₴₽]{2,16})\s*(?:на|в|to|->|→)\s*(?:(\d+(?:[.,]\d+)?)\s*)?([A-Za-zА-Яа-яЁё$€₴₽]{2,16})/iu
	)
	if (explicit) {
		const srcAmount = Number(String(explicit[1]).replace(',', '.'))
		const srcCurrency = normalizeExchangeCurrency(explicit[2] ?? '')
		const dstAmountRaw = explicit[3]
		let dstCurrency = normalizeExchangeCurrency(explicit[4] ?? '')
		let dstAmount =
			dstAmountRaw != null && dstAmountRaw !== ''
				? Number(String(dstAmountRaw).replace(',', '.'))
				: null
		if (!dstCurrency || dstCurrency === srcCurrency) {
			const inferredTarget = connectorCandidates.find(
				item => item.currency !== srcCurrency
			)
			if (inferredTarget) {
				dstCurrency = inferredTarget.currency
				if (
					(dstAmount == null || !Number.isFinite(dstAmount)) &&
					inferredTarget.amount != null
				) {
					dstAmount = inferredTarget.amount
				}
			}
		}
		if (srcCurrency && dstCurrency && srcCurrency !== dstCurrency) {
			return {
				sourceAmount: Number.isFinite(srcAmount) ? Math.abs(srcAmount) : null,
				sourceCurrency: srcCurrency || null,
				targetAmount:
					dstAmount != null && Number.isFinite(dstAmount)
						? Math.abs(dstAmount)
						: null,
				targetCurrency: dstCurrency || null,
				explicitPair: true
			}
		}
	}

	const exchangeSignal = /\b(валютообмен|обмен|конвертац|swap|exchange)\b/iu.test(
		source
	)
	if (!exchangeSignal || !pairs.length) return null

	const normalizedPairs = pairs
		.map(pair => ({
			amount: Math.abs(Number(pair.amount ?? 0)),
			currency: normalizeExchangeCurrency(String(pair.currency ?? ''))
		}))
		.filter(pair => pair.currency && Number.isFinite(pair.amount) && pair.amount > 0)
	if (!normalizedPairs.length) return null

	const sourcePair = normalizedPairs[0]
	let targetPair = normalizedPairs.find(
		pair => pair.currency !== sourcePair.currency
	)

	if (!targetPair) {
		const targetOnly = connectorCandidates.find(
			item => item.currency !== sourcePair.currency
		)
		const targetCurrency = targetOnly?.currency ?? ''
		if (targetCurrency && targetCurrency !== sourcePair.currency) {
			return {
				sourceAmount: sourcePair.amount,
				sourceCurrency: sourcePair.currency,
				targetAmount: targetOnly?.amount ?? null,
				targetCurrency,
				explicitPair: false
			}
		}
	}

	if (!targetPair) return null
	return {
		sourceAmount: sourcePair.amount,
		sourceCurrency: sourcePair.currency,
		targetAmount: targetPair.amount,
		targetCurrency: targetPair.currency,
		explicitPair: false
	}
}

function getAssetAmountByCurrency(
	account: ExchangeAccountCandidate,
	currency: string
): number {
	const code = String(currency ?? '').toUpperCase()
	if (!code) return 0
	for (const asset of account.assets ?? []) {
		const assetCode = String(asset.currency ?? '').toUpperCase()
		if (assetCode !== code) continue
		const amount = Number(asset.amount ?? 0)
		return Number.isFinite(amount) ? amount : 0
	}
	return 0
}

function accountHasCurrency(
	account: ExchangeAccountCandidate,
	currency: string
): boolean {
	const code = String(currency ?? '').toUpperCase()
	if (!code) return false
	for (const asset of account.assets ?? []) {
		const assetCode = String(asset.currency ?? '').toUpperCase()
		if (assetCode === code) return true
	}
	return false
}

export function pickSourceAccountId(params: {
	accounts: ExchangeAccountCandidate[]
	statsByAccountId?: Map<string, ExchangeAccountStats>
	sourceCurrency: string
	requiredAmount: number
	defaultAccountId?: string | null
}): string | null {
	const sourceCurrency = String(params.sourceCurrency ?? '').toUpperCase()
	if (!sourceCurrency) return null
	const stats = params.statsByAccountId ?? new Map<string, ExchangeAccountStats>()
	const requiredAmount = Number(params.requiredAmount ?? 0)
	const candidates = (params.accounts ?? [])
		.map(account => ({
			id: account.id,
			amount: getAssetAmountByCurrency(account, sourceCurrency),
			stats: stats.get(account.id) ?? { usageCount: 0, lastUsedAtMs: 0 }
		}))
		.filter(row => row.amount > 0)
	if (!candidates.length) return null

	const enough = requiredAmount > 0
		? candidates.filter(row => row.amount >= requiredAmount)
		: candidates
	const target = enough.length ? enough : candidates
	target.sort((a, b) => {
		if (b.amount !== a.amount) return b.amount - a.amount
		if (b.stats.lastUsedAtMs !== a.stats.lastUsedAtMs) {
			return b.stats.lastUsedAtMs - a.stats.lastUsedAtMs
		}
		if (b.stats.usageCount !== a.stats.usageCount) {
			return b.stats.usageCount - a.stats.usageCount
		}
		const aDefault = params.defaultAccountId && a.id === params.defaultAccountId ? 1 : 0
		const bDefault = params.defaultAccountId && b.id === params.defaultAccountId ? 1 : 0
		if (bDefault !== aDefault) return bDefault - aDefault
		return a.id.localeCompare(b.id)
	})
	return target[0]?.id ?? null
}

export function pickTargetAccountId(params: {
	accounts: ExchangeAccountCandidate[]
	statsByAccountId?: Map<string, ExchangeAccountStats>
	targetCurrency: string
	defaultAccountId?: string | null
}): string | null {
	const targetCurrency = String(params.targetCurrency ?? '').toUpperCase()
	if (!targetCurrency) return null
	const stats = params.statsByAccountId ?? new Map<string, ExchangeAccountStats>()
	const candidates = (params.accounts ?? [])
		.map(account => ({
			id: account.id,
			hasCurrency: accountHasCurrency(account, targetCurrency),
			amount: getAssetAmountByCurrency(account, targetCurrency),
			stats: stats.get(account.id) ?? { usageCount: 0, lastUsedAtMs: 0 }
		}))
		.filter(row => row.hasCurrency)
	if (!candidates.length) return null
	candidates.sort((a, b) => {
		if (b.stats.lastUsedAtMs !== a.stats.lastUsedAtMs) {
			return b.stats.lastUsedAtMs - a.stats.lastUsedAtMs
		}
		if (b.stats.usageCount !== a.stats.usageCount) {
			return b.stats.usageCount - a.stats.usageCount
		}
		const aDefault = params.defaultAccountId && a.id === params.defaultAccountId ? 1 : 0
		const bDefault = params.defaultAccountId && b.id === params.defaultAccountId ? 1 : 0
		if (bDefault !== aDefault) return bDefault - aDefault
		return a.id.localeCompare(b.id)
	})
	return candidates[0]?.id ?? null
}
