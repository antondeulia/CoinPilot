import { InlineKeyboard } from 'grammy'
import { formatAccountName } from 'src/utils/format'

export function accountSwitchKeyboard(
	accounts: { id: string; name: string }[],
	_activeId: string | null,
	page = 0,
	selectedId?: string | null,
	defaultAccountId?: string
) {
	const kb = new InlineKeyboard()
	const pageSize = 9
	const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))
	const start = page * pageSize
	const currentPageAccounts = accounts.slice(start, start + pageSize)

	for (let i = 0; i < currentPageAccounts.length; i += 3) {
		const rowAccounts = currentPageAccounts.slice(i, i + 3)
		for (const acc of rowAccounts) {
			const isDefault = acc.id === defaultAccountId
			const isSelected = acc.id === selectedId
			const label = isSelected ? `✅ ${acc.name}` : acc.name
			const displayName = formatAccountName(label, isDefault)
			kb.text(displayName, `use_account:${acc.id}`)
		}
		kb.row()
	}

	kb.text('« Назад', 'accounts_page_prev')
		.text(`${page + 1}/${totalPages}`, 'accounts_page_current')
		.text('Вперёд »', 'accounts_page_next')
		.row()

	if (selectedId) {
		kb.text('Jarvis-редактирование', 'accounts_jarvis_edit_details').row()
		kb.text('Снять выделение', 'accounts_unselect').row()
	} else {
		kb.text('+ Добавить счёт', 'add_account').row()
		kb.text('🠐 Назад', 'accounts_back')
	}

	return kb
}
