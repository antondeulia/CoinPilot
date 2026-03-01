import {
	mergeAccountAssetsPreferLlm,
	normalizeAccountCurrency,
	parseRuleBasedAssetsChunk
} from './account-parse.utils'

describe('account-parse.utils', () => {
	const supported = new Set(['EUR', 'USD', 'RUB', 'UAH'])
	const normalize = (raw: string) => normalizeAccountCurrency(raw, supported)

	it('parses assets with connector "и"', () => {
		const assets = parseRuleBasedAssetsChunk('300 евро и 200 дол', normalize)
		expect(assets).toEqual([
			{ currency: 'EUR', amount: 300 },
			{ currency: 'USD', amount: 200 }
		])
	})

	it('parses assets without connector the same way', () => {
		const withConnector = parseRuleBasedAssetsChunk('300 евро и 200 дол', normalize)
		const withoutConnector = parseRuleBasedAssetsChunk('300 евро 200 дол', normalize)
		expect(withoutConnector).toEqual(withConnector)
	})

	it('does not lose llm currencies while merging with rule-based assets', () => {
		const llmAssets = [
			{ currency: 'EUR', amount: 300 },
			{ currency: 'USD', amount: 200 }
		]
		const ruleAssets = [{ currency: 'EUR', amount: 300 }]
		expect(mergeAccountAssetsPreferLlm(llmAssets, ruleAssets)).toEqual(llmAssets)
	})

	it('replaces llm zero with positive rule amount for same currency', () => {
		const llmAssets = [{ currency: 'USD', amount: 0 }]
		const ruleAssets = [{ currency: 'USD', amount: 200 }]
		expect(mergeAccountAssetsPreferLlm(llmAssets, ruleAssets)).toEqual([
			{ currency: 'USD', amount: 200 }
		])
	})
})
