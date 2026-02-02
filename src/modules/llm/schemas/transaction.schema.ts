import { z } from 'zod'

export const LlmTransactionSchema = z.object({
	action: z.literal('create_transaction'),
	amount: z.number().positive().optional(),
	currency: z.string().optional(),
	direction: z.enum(['income', 'expense']),
	category: z.string().optional(),
	description: z.string().optional(),
	rawText: z.string().optional()
})

export type LlmTransaction = z.infer<typeof LlmTransactionSchema>
