import { z } from 'zod'

export const LlmAccountAssetSchema = z.object({
	currency: z.string(),
	amount: z.preprocess(value => {
		if (value == null || value === '') return 0
		if (typeof value === 'number') return value
		const normalized = Number(String(value).replace(',', '.'))
		return Number.isFinite(normalized) ? normalized : 0
	}, z.number())
})

export const LlmAccountSchema = z.object({
	name: z.string(),
	assets: z.array(LlmAccountAssetSchema).min(1),
	emoji: z.string().optional(),
	accountType: z
		.enum(['bank', 'exchange', 'crypto_wallet', 'cash', 'online_service', 'other'])
		.optional(),
	rawText: z.string().optional()
})

export const LlmAccountListSchema = z.object({
	accounts: z.array(LlmAccountSchema).min(1)
})

export type LlmAccount = z.infer<typeof LlmAccountSchema>
