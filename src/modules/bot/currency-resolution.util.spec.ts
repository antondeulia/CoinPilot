import {
	detectExplicitCurrencyMentions,
	inferCurrencyBalanceThenFirst,
	resolveTransactionCurrency
} from './currency-resolution.util'

describe('currency-resolution.util', () => {
	const supported = new Set(['EUR', 'USD', 'RUB', 'UAH'])

	it('detects explicit short dollar mention', () => {
		const mentions = detectExplicitCurrencyMentions('300 евро и 200 дол', supported)
		expect(Array.from(mentions).sort()).toEqual(['EUR', 'USD'])
	})

	it('infers expense currency by balance then first', () => {
		const currency = inferCurrencyBalanceThenFirst({
			direction: 'expense',
			amount: 50,
			assets: [
				{ currency: 'EUR', amount: 10 },
				{ currency: 'USD', amount: 200 }
			],
			fallbackAccountCurrency: 'EUR'
		})
		expect(currency).toBe('USD')
	})

	it('falls back to first account currency when balance is insufficient', () => {
		const currency = inferCurrencyBalanceThenFirst({
			direction: 'expense',
			amount: 500,
			assets: [
				{ currency: 'EUR', amount: 100 },
				{ currency: 'USD', amount: 20 }
			],
			fallbackAccountCurrency: 'EUR'
		})
		expect(currency).toBe('EUR')
	})

	it('uses first account currency for income without explicit currency', () => {
		const currency = inferCurrencyBalanceThenFirst({
			direction: 'income',
			amount: 100,
			assets: [
				{ currency: 'EUR', amount: 0 },
				{ currency: 'USD', amount: 0 }
			],
			fallbackAccountCurrency: 'EUR'
		})
		expect(currency).toBe('EUR')
	})

	it('replaces non-explicit llm RUB with inferred account currency', () => {
		const result = resolveTransactionCurrency({
			rawText: 'кофе 20',
			description: 'Кофе',
			llmCurrency: 'RUB',
			direction: 'expense',
			amount: 20,
			assets: [
				{ currency: 'EUR', amount: 100 },
				{ currency: 'USD', amount: 30 }
			],
			fallbackAccountCurrency: 'EUR',
			supportedCurrencies: supported
		})
		expect(result).toEqual({
			currency: 'EUR',
			source: 'inferred',
			explicitMentioned: false
		})
	})

	it('keeps explicit currency even when it is absent on account', () => {
		const result = resolveTransactionCurrency({
			rawText: 'кофе 20 usd',
			description: 'Кофе',
			llmCurrency: 'USD',
			direction: 'expense',
			amount: 20,
			assets: [{ currency: 'EUR', amount: 100 }],
			fallbackAccountCurrency: 'EUR',
			supportedCurrencies: supported
		})
		expect(result).toEqual({
			currency: 'USD',
			source: 'explicit',
			explicitMentioned: true
		})
	})
})
