export interface ParsedAccountAsset {
	currency: string
	amount: number
}

export const ACCOUNT_CURRENCY_ALIASES: Record<string, string> = {
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
	USDT: 'USDT',
	ТЕТЕР: 'USDT',
	'€': 'EUR',
	EUR: 'EUR',
	ЕВРО: 'EUR',
	'₴': 'UAH',
	UAH: 'UAH',
	ГРН: 'UAH',
	ГРИВНА: 'UAH',
	ГРИВНЫ: 'UAH',
	'₽': 'RUB',
	RUB: 'RUB',
	RUR: 'RUB',
	РУБ: 'RUB',
	РУБЛЬ: 'RUB',
	РУБЛЯ: 'RUB',
	РУБЛЕЙ: 'RUB',
	'£': 'GBP',
	GBP: 'GBP',
	ФУНТ: 'GBP',
	BYN: 'BYN',
	BYP: 'BYN',
	BYR: 'BYN',
	БЕЛРУБ: 'BYN',
	БЕЛОРУБЛЬ: 'BYN',
	БЕЛОРУССКИЙРУБЛЬ: 'BYN'
}

const ASSET_CONNECTOR_RE = /^(and|и|та|&|\+)$/iu

export function normalizeAccountCurrency(
	raw: string,
	supportedCurrencySet?: Set<string> | null
): string {
	const compact = String(raw ?? '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '')
	if (!compact) return ''
	const aliasCode = ACCOUNT_CURRENCY_ALIASES[compact]
	if (aliasCode) {
		return !supportedCurrencySet || supportedCurrencySet.has(aliasCode)
			? aliasCode
			: ''
	}
	const token = compact.replace(/[^A-Z0-9]/g, '')
	const tokenAlias = ACCOUNT_CURRENCY_ALIASES[token]
	if (tokenAlias) {
		return !supportedCurrencySet || supportedCurrencySet.has(tokenAlias)
			? tokenAlias
			: ''
	}
	if (/^[A-Z][A-Z0-9]{1,9}$/.test(token)) {
		if (!supportedCurrencySet) return token
		return supportedCurrencySet.has(token) ? token : ''
	}
	return ''
}

export function parseRuleBasedAssetsChunk(
	chunk: string,
	normalizeCurrency: (raw: string) => string
): ParsedAccountAsset[] {
	const source = String(chunk ?? '').trim()
	if (!source) return []
	const pairs = new Map<string, number>()
	const add = (currencyRaw: string, amountRaw?: unknown) => {
		const code = normalizeCurrency(currencyRaw)
		if (!code) return
		const amount =
			typeof amountRaw === 'number'
				? amountRaw
				: Number(String(amountRaw ?? '').replace(',', '.').trim())
		const safeAmount = Number.isFinite(amount) ? Number(amount) : 0
		const prev = pairs.get(code) ?? 0
		pairs.set(code, Number((prev + safeAmount).toFixed(12)))
	}
	const numberRe = /^-?\d+(?:[.,]\d+)?$/u
	const tokens: string[] = Array.from(
		source.matchAll(/-?\d+(?:[.,]\d+)?|[A-Za-zА-Яа-яЁё$€₴£₽]{1,16}/gu)
	).map(m => m[0])
	const consumed = new Set<number>()
	for (let i = 0; i < tokens.length; i++) {
		if (consumed.has(i)) continue
		const current = tokens[i]
		const next = tokens[i + 1]
		if (!next || consumed.has(i + 1)) continue
		if (ASSET_CONNECTOR_RE.test(current) || ASSET_CONNECTOR_RE.test(next)) continue
		const currentIsNumber = numberRe.test(current)
		const nextIsNumber = numberRe.test(next)
		if (currentIsNumber && !nextIsNumber) {
			const code = normalizeCurrency(next)
			if (!code) continue
			add(code, current)
			consumed.add(i)
			consumed.add(i + 1)
			i += 1
			continue
		}
		if (!currentIsNumber && nextIsNumber) {
			const code = normalizeCurrency(current)
			if (!code) continue
			add(code, next)
			consumed.add(i)
			consumed.add(i + 1)
			i += 1
		}
	}
	for (let i = 0; i < tokens.length; i++) {
		if (consumed.has(i)) continue
		const token = tokens[i]
		if (ASSET_CONNECTOR_RE.test(token)) continue
		const code = normalizeCurrency(token)
		if (!code) continue
		if (!pairs.has(code)) pairs.set(code, 0)
	}
	return Array.from(pairs.entries()).map(([currency, amount]) => ({
		currency,
		amount
	}))
}

export function mergeAccountAssetsPreferLlm(
	llmAssets: ParsedAccountAsset[],
	ruleAssets: ParsedAccountAsset[]
): ParsedAccountAsset[] {
	const merged = new Map<string, number>()
	for (const asset of llmAssets ?? []) {
		const code = String(asset.currency ?? '').toUpperCase().trim()
		if (!code) continue
		const amount = Number(asset.amount ?? 0)
		if (!Number.isFinite(amount)) continue
		merged.set(code, Number(amount.toFixed(12)))
	}
	for (const asset of ruleAssets ?? []) {
		const code = String(asset.currency ?? '').toUpperCase().trim()
		if (!code) continue
		const amount = Number(asset.amount ?? 0)
		if (!Number.isFinite(amount)) continue
		if (!merged.has(code)) {
			merged.set(code, Number(amount.toFixed(12)))
			continue
		}
		const llmAmount = Number(merged.get(code) ?? 0)
		if (llmAmount === 0 && amount > 0) {
			merged.set(code, Number(amount.toFixed(12)))
		}
	}
	return Array.from(merged.entries()).map(([currency, amount]) => ({
		currency,
		amount
	}))
}
