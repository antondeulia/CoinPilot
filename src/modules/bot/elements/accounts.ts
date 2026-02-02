import { Account } from 'generated/prisma/client'
import { InlineKeyboard } from 'grammy'

export function accountsKeyboard(accounts: Account[], activeId: string | null) {
	const kb = new InlineKeyboard()

	for (const acc of accounts) {
		kb.text(
			`${acc.id === activeId ? '👉 ' : ''}${acc.name} (${acc.currency})`,
			`use_account:${acc.id}`
		).row()
	}

	kb.text('➕ Добавить счёт', 'add_account')

	return kb
}
