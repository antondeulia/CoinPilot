import {
	extractExchangeIntentFromText,
	pickSourceAccountId,
	pickTargetAccountId
} from './exchange-intent.util'

describe('exchange-intent.util', () => {
	it('extracts explicit exchange intent with target amount', () => {
		const intent = extractExchangeIntentFromText('обмен 500 usd на 460 eur', [])
		expect(intent).toEqual({
			sourceAmount: 500,
			sourceCurrency: 'USD',
			targetAmount: 460,
			targetCurrency: 'EUR',
			explicitPair: true
		})
	})

	it('extracts explicit exchange intent without target amount', () => {
		const intent = extractExchangeIntentFromText('обмен 500 юсд на евро', [])
		expect(intent).toEqual({
			sourceAmount: 500,
			sourceCurrency: 'USD',
			targetAmount: null,
			targetCurrency: 'EUR',
			explicitPair: true
		})
	})

	it('extracts target currency when account names are present between connectors', () => {
		const intent = extractExchangeIntentFromText(
			'обменял 400 дол на пайпеле на евро на моно банке',
			[]
		)
		expect(intent).toEqual({
			sourceAmount: 400,
			sourceCurrency: 'USD',
			targetAmount: null,
			targetCurrency: 'EUR',
			explicitPair: true
		})
	})

	it('picks source account by max source balance then stats', () => {
		const stats = new Map([
			['a', { usageCount: 12, lastUsedAtMs: 1000 }],
			['b', { usageCount: 30, lastUsedAtMs: 5000 }],
			['c', { usageCount: 2, lastUsedAtMs: 100 }]
		]) as any
		const id = pickSourceAccountId({
			sourceCurrency: 'USD',
			requiredAmount: 500,
			statsByAccountId: stats,
			accounts: [
				{ id: 'a', assets: [{ currency: 'USD', amount: 0 }] },
				{ id: 'b', assets: [{ currency: 'USD', amount: 400 }] },
				{ id: 'c', assets: [{ currency: 'USD', amount: 700 }] }
			]
		})
		expect(id).toBe('c')
	})

	it('picks target account by recency then frequency', () => {
		const stats = new Map([
			['mono', { usageCount: 5, lastUsedAtMs: 7000 }],
			['wise', { usageCount: 20, lastUsedAtMs: 6000 }],
			['rev', { usageCount: 100, lastUsedAtMs: 1000 }]
		]) as any
		const id = pickTargetAccountId({
			targetCurrency: 'EUR',
			statsByAccountId: stats,
			accounts: [
				{ id: 'mono', assets: [{ currency: 'EUR', amount: 1 }] },
				{ id: 'wise', assets: [{ currency: 'EUR', amount: 2 }] },
				{ id: 'rev', assets: [{ currency: 'EUR', amount: 3 }] }
			]
		})
		expect(id).toBe('mono')
	})

	it('returns null when no account has target currency', () => {
		const id = pickTargetAccountId({
			targetCurrency: 'EUR',
			accounts: [{ id: 'paypal', assets: [{ currency: 'USD', amount: 100 }] }]
		})
		expect(id).toBeNull()
	})

	it('allows zero target balance when account contains target currency asset', () => {
		const id = pickTargetAccountId({
			targetCurrency: 'EUR',
			accounts: [
				{ id: 'mono', assets: [{ currency: 'EUR', amount: 0 }] },
				{ id: 'paypal', assets: [{ currency: 'USD', amount: 100 }] }
			]
		})
		expect(id).toBe('mono')
	})
})
