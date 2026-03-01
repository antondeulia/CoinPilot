import { InlineKeyboard } from 'grammy'

type SettingsViewUser = {
	id: string
	telegramId: string
	mainCurrency?: string
	timezone?: string
	defaultAccountId?: string | null
	accounts: { id: string; name: string; isHidden?: boolean }[]
	isPremium: boolean
	premiumUntil?: Date | string | null
	createdAt?: Date | string
}

function isPremiumNow(user: SettingsViewUser): boolean {
	if (!user.isPremium) return false
	if (!user.premiumUntil) return true
	return new Date(user.premiumUntil) > new Date()
}

function createdAtLabel(value?: Date | string): string {
	const createdAt = value ? new Date(value) : new Date()
	return `${String(createdAt.getDate()).padStart(2, '0')}.${String(
		createdAt.getMonth() + 1
	).padStart(2, '0')}.${createdAt.getFullYear()}`
}

export function mainCurrencyPickerKeyboard(): InlineKeyboard {
	return new InlineKeyboard()
		.text('EUR', 'main_currency_set:EUR')
		.text('USD', 'main_currency_set:USD')
		.row()
		.text('UAH', 'main_currency_set:UAH')
		.text('BYN', 'main_currency_set:BYN')
		.row()
		.text('Закрыть', 'back_to_settings')
}

export function timezonePickerKeyboard(): InlineKeyboard {
	return new InlineKeyboard()
		.text('UTC+2 — Киев, Вильнюс, Афины', 'timezone_set:+2')
		.text('UTC+1 — Берлин, Париж, Рим', 'timezone_set:+1')
		.row()
		.text('UTC+0 — Лондон, Лиссабон', 'timezone_set:0')
		.text('UTC–1 — Азорские острова', 'timezone_set:-1')
		.row()
		.text('Закрыть', 'back_to_settings')
}

export function buildSettingsView(
	user: SettingsViewUser,
	_alertsEnabledCount: number = 0
): { text: string; keyboard: InlineKeyboard } {
	const mainCode = user?.mainCurrency ?? 'USD'
	const timezone = user?.timezone ?? 'UTC+02:00'
	const visibleAccounts = (user.accounts ?? []).filter(a => !a.isHidden)
	const defaultAccount =
		visibleAccounts.find(a => a.id === user.defaultAccountId) ?? null
	const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
	const isPrem = isPremiumNow(user)
	const tariffStr = isPrem ? 'Pro' : 'Basic'
	const createdAtStr = createdAtLabel(user.createdAt)
	const text = `⚙️ Настройки

💠 Ваш тариф: ${tariffStr}
🌍 Основная валюта: ${mainCode}
🕒 Часовой пояс: ${timezone}
🏦 Основной счёт: ${defaultAccountName}

🆔 Ваш Telegram ID: ${user.telegramId}
📅 Дата регистрации: ${createdAtStr}`
	const keyboard = new InlineKeyboard()
		.text('🌍 Основная валюта', 'main_currency_open')
		.text('🕒 Часовой пояс', 'timezone_open')
		.row()
		.text('🏦 Основной счёт', 'default_account_open')
			.row()
		.text('📂 Категории', 'view_categories')
		.text('🏷️ Теги', 'view_tags')
		.row()
		.text(isPrem ? '💠 Подписка' : '⭐️ Подписка', isPrem ? 'view_subscription' : 'view_premium')
		.row()
		.text('❌ Удалить все данные', 'confirm_delete_all_data')
		.row()
		.text('← Назад', 'go_home')
	return { text, keyboard }
}
