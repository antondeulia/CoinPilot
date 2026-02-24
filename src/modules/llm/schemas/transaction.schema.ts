import { z } from 'zod'

export const LlmTransactionSchema = z.object({
	action: z.literal('create_transaction'),
	amount: z.number().optional(),
	currency: z.string().optional(),
	direction: z.enum(['expense', 'income', 'transfer']),
	fromAccount: z.string().optional(),
	toAccount: z.string().optional(),
	account: z.string().optional(),
	accountId: z.string().optional(),
	transactionDate: z.string().optional(),
	categoryId: z.string().optional(),
	category: z.string().optional(),
	description: z.string().optional(),
	rawText: z.string().optional(),
	convertToCurrency: z.string().optional(),
	convertedAmount: z.number().optional(),
	tag_text: z.string().optional(),
	normalized_tag: z.string().optional(),
	tag_confidence: z.number().optional(),
	tradeType: z.enum(['buy', 'sell']).optional(),
	tradeBaseCurrency: z.string().optional(),
	tradeBaseAmount: z.number().optional(),
	tradeQuoteCurrency: z.string().optional(),
	tradeQuoteAmount: z.number().optional(),
	executionPrice: z.number().optional(),
	tradeFeeCurrency: z.string().optional(),
	tradeFeeAmount: z.number().optional()
})

export const LlmTransactionListSchema = z.object({
	transactions: z.array(LlmTransactionSchema)
})

export type LlmTransaction = z.infer<typeof LlmTransactionSchema>
