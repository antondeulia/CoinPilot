import { canonicalizeTradePayload } from './canonicalize-trade'

describe('canonicalizeTradePayload', () => {
	it('normalizes buy payload into quote->base mapping', () => {
		const canonical = canonicalizeTradePayload({
			tradeType: 'buy',
			tradeBaseCurrency: 'ton',
			tradeBaseAmount: 11.1,
			tradeQuoteCurrency: 'usdt',
			tradeQuoteAmount: 14.9628
		})
		expect(canonical).not.toBeNull()
		expect(canonical?.amount).toBeCloseTo(14.9628, 8)
		expect(canonical?.currency).toBe('USDT')
		expect(canonical?.convertedAmount).toBeCloseTo(11.1, 8)
		expect(canonical?.convertToCurrency).toBe('TON')
	})

	it('normalizes sell payload into base->quote mapping', () => {
		const canonical = canonicalizeTradePayload({
			tradeType: 'sell',
			tradeBaseCurrency: 'lab',
			tradeBaseAmount: 753,
			tradeQuoteCurrency: 'usdt',
			tradeQuoteAmount: 109.938
		})
		expect(canonical).not.toBeNull()
		expect(canonical?.amount).toBeCloseTo(753, 8)
		expect(canonical?.currency).toBe('LAB')
		expect(canonical?.convertedAmount).toBeCloseTo(109.938, 8)
		expect(canonical?.convertToCurrency).toBe('USDT')
	})
})
