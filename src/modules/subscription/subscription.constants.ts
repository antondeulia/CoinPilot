export const FREE_LIMITS = {
	// Максимум активных счетов для Basic
	MAX_ACCOUNTS: 2,
	// Максимум активов (валют) внутри одного счёта для Basic
	MAX_ASSETS_PER_ACCOUNT: 10,
	// Кол-во кастомных категорий (0 — только дефолтные)
	MAX_CUSTOM_CATEGORIES: 0,
	// Кол-во кастомных тегов
	MAX_CUSTOM_TAGS: 3,
	// Лимит фото-распознаваний в месяц для Basic
	MAX_IMAGE_PARSES_PER_MONTH: 1,
	// Экспорт только в Pro-тарифе
	EXPORT_ALLOWED: false
} as const

export const PRICES = {
	monthly: { amount: 499, label: '3,99 €/мес' },
	yearly: { amount: 3999, label: '29,99 €/год (≈2,49 €/мес)' }
} as const

export const TRIAL_DAYS = 7
