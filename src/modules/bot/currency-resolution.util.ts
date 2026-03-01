export type CurrencyResolutionSource = 'explicit' | 'inferred'

export interface CurrencyResolutionResult {
	currency: string | null
	source: CurrencyResolutionSource
	explicitMentioned: boolean
}

export interface CurrencyAccountAsset {
	currency: string
	amount: number
}

const CURRENCY_ALIASES: Record<string, string> = {
	$: 'USD',
	USD: 'USD',
	US$: 'USD',
	ДОЛ: 'USD',
	ДОЛЛ: 'USD',
	'ДОЛ.': 'USD',
	'ДОЛЛ.': 'USD',
	ДОЛЛАР: 'USD',
	ДОЛЛАРЫ: 'USD',
	ДОЛЛАРОВ: 'USD',
	DOL: 'USD',
	DLL: 'USD',
	'€': 'EUR',
	EUR: 'EUR',
	ЕВРО: 'EUR',
	'₽': 'RUB',
	RUB: 'RUB',
	RUR: 'RUB',
	РУБ: 'RUB',
	РУБЛЬ: 'RUB',
	РУБЛЯ: 'RUB',
	РУБЛЕЙ: 'RUB',
	'₴': 'UAH',
	UAH: 'UAH',
	ГРН: 'UAH',
	ГРИВНА: 'UAH',
	ГРИВНЫ: 'UAH',
	'£': 'GBP',
	GBP: 'GBP',
	ФУНТ: 'GBP',
	USDT: 'USDT',
	ТЕТЕР: 'USDT',
	TON: 'TON',
	ТОН: 'TON',
	BTC: 'BTC',
	БИТКОИН: 'BTC',
	ETH: 'ETH',
	ЭФИР: 'ETH'
}

export function normalizeCurrencyMentionToken(
	raw: string,
	supportedCurrencies?: Set<string>
): string {
	const compact = String(raw ?? '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '')
	if (!compact) return ''
	const alias = CURRENCY_ALIASES[compact]
	if (alias) {
		return !supportedCurrencies || supportedCurrencies.has(alias) ? alias : ''
	}
	const token = compact.replace(/[^A-Z0-9]/g, '')
	if (!token) return ''
	const aliasByToken = CURRENCY_ALIASES[token]
	if (aliasByToken) {
		return !supportedCurrencies || supportedCurrencies.has(aliasByToken)
			? aliasByToken
			: ''
	}
	if (/^[A-Z][A-Z0-9]{1,9}$/.test(token)) {
		if (!supportedCurrencies) return token
		return supportedCurrencies.has(token) ? token : ''
	}
	return ''
}

export function detectExplicitCurrencyMentions(
	text: string,
	supportedCurrencies?: Set<string>
): Set<string> {
	const source = String(text ?? '')
	const found = new Set<string>()
	for (const match of source.matchAll(/[A-Za-zА-Яа-яЁё$€₽₴£]{1,16}/gu)) {
		const code = normalizeCurrencyMentionToken(match[0], supportedCurrencies)
		if (code) found.add(code)
	}
	return found
}

export function inferCurrencyBalanceThenFirst(params: {
	direction?: string
	amount?: number
	assets: CurrencyAccountAsset[]
	fallbackAccountCurrency?: string | null
}): string | null {
	const assets = (params.assets ?? [])
		.map(asset => ({
			currency: String(asset.currency ?? '').toUpperCase().trim(),
			amount: Number(asset.amount ?? 0)
		}))
		.filter(asset => !!asset.currency && Number.isFinite(asset.amount))
	const fallback = String(params.fallbackAccountCurrency ?? '')
		.toUpperCase()
		.trim()
	const firstCurrency = assets[0]?.currency ?? (fallback || null)
	if (!firstCurrency) return null
	if (params.direction === 'income') return firstCurrency
	const amount = Number(params.amount ?? 0)
	if (Number.isFinite(amount) && amount > 0) {
		const byBalance = assets.find(asset => asset.amount >= amount)
		if (byBalance?.currency) return byBalance.currency
	}
	return firstCurrency
}

export function resolveTransactionCurrency(params: {
	rawText?: string | null
	description?: string | null
	llmCurrency?: string | null
	direction?: 'income' | 'expense' | 'transfer' | string
	amount?: number
	assets: CurrencyAccountAsset[]
	fallbackAccountCurrency?: string | null
	supportedCurrencies?: Set<string>
}): CurrencyResolutionResult {
	const sourceText = `${String(params.rawText ?? '')} ${String(params.description ?? '')}`
	const explicitMentions = detectExplicitCurrencyMentions(
		sourceText,
		params.supportedCurrencies
	)
	const llmCurrency = normalizeCurrencyMentionToken(
		String(params.llmCurrency ?? ''),
		params.supportedCurrencies
	)
	const hasLlmCurrency = !!llmCurrency
	const accountCurrencies = new Set(
		(params.assets ?? [])
			.map(asset => String(asset.currency ?? '').toUpperCase().trim())
			.filter(Boolean)
	)
	const explicitMentioned = hasLlmCurrency && explicitMentions.has(llmCurrency)
	if (explicitMentioned) {
		return {
			currency: llmCurrency,
			source: 'explicit',
			explicitMentioned: true
		}
	}
	if (hasLlmCurrency && accountCurrencies.has(llmCurrency)) {
		return {
			currency: llmCurrency,
			source: 'inferred',
			explicitMentioned: false
		}
	}
	const inferred = inferCurrencyBalanceThenFirst({
		direction: params.direction,
		amount: params.amount,
		assets: params.assets ?? [],
		fallbackAccountCurrency: params.fallbackAccountCurrency
	})
	if (inferred) {
		return {
			currency: inferred,
			source: 'inferred',
			explicitMentioned: false
		}
	}
	return {
		currency: hasLlmCurrency ? llmCurrency : null,
		source: 'inferred',
		explicitMentioned: false
	}
}
