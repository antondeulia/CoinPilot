import { InlineKeyboard } from 'grammy'

export function accountSwitchKeyboard(accounts, activeId) {
	const kb = new InlineKeyboard()

	for (const acc of accounts) {
		kb.text(
			acc.id === activeId ? `✅ ${acc.name}` : acc.name,
			`use_account:${acc.id}`
		).row()
	}

	kb.row()
		.text('➕ Добавить счёт', 'add_account')
		.row()
		.text('⬅️ Скрыть', 'hide_message')

	return kb
}
