import { z } from 'zod'

export const LlmAccountAssetSchema = z.object({
	currency: z.string(),
	amount: z.number()
})

export const LlmAccountSchema = z.object({
	name: z.string(),
	assets: z.array(LlmAccountAssetSchema).min(1),
	rawText: z.string().optional()
})

export const LlmAccountListSchema = z.object({
	accounts: z.array(LlmAccountSchema).min(1)
})

export type LlmAccount = z.infer<typeof LlmAccountSchema>
