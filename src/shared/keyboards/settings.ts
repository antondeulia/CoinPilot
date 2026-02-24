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

export function buildSettingsView(
	user: SettingsViewUser,
	alertsEnabledCount: number
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
	const notificationsLabel =
		(alertsEnabledCount > 0 ? '🔔 ' : '🔕 ') +
		'Уведомления: ' +
		(alertsEnabledCount > 0 ? 'Вкл' : 'Выкл')
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
		.text('⭐️ Подписка', isPrem ? 'view_subscription' : 'view_premium')
		.text(notificationsLabel, 'analytics_alerts')
		.row()
		.text('❌ Удалить все данные', 'confirm_delete_all_data')
		.row()
		.text('← Назад', 'go_home')
	return { text, keyboard }
}
