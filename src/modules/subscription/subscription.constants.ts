export const FREE_LIMITS = {
	// Максимум активных счетов для Free
	MAX_ACCOUNTS: 2,
	// Максимум активов (валют) внутри одного счёта для Free
	MAX_ASSETS_PER_ACCOUNT: 10,
	// Кол-во кастомных категорий (0 — только дефолтные)
	MAX_CUSTOM_CATEGORIES: 0,
	// Кол-во кастомных тегов
	MAX_CUSTOM_TAGS: 3,
	// Лимит фото-распознаваний в месяц для Free
	MAX_IMAGE_PARSES_PER_MONTH: 1,
	// Экспорт только в Premium
	EXPORT_ALLOWED: false
} as const

export const PRICES = {
	monthly: { amount: 499, label: '4,99 €/мес' },
	yearly: { amount: 3999, label: '39,99 €/год (≈3,33 €/мес)' }
} as const

export const TRIAL_DAYS = 7
