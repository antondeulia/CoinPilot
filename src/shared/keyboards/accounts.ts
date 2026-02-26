import { InlineKeyboard } from 'grammy'
import { formatAccountName } from '../../utils/format'

export function accountSwitchKeyboard(
	accounts: { id: string; name: string }[],
	_activeId: string | null,
	page = 0,
	selectedId?: string | null,
	defaultAccountId?: string,
	frozenIds: Set<string> = new Set(),
	selectedFrozen = false,
	accountsViewExpanded = false
) {
	const kb = new InlineKeyboard()
	if (!selectedId) {
		kb.text(
			accountsViewExpanded ? 'Скрыть' : 'Показать все счета',
			'accounts_view_toggle'
		).row()
	}
	const pageSize = 9
	const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize))
	const start = page * pageSize
	const currentPageAccounts = accounts.slice(start, start + pageSize)

	for (let i = 0; i < currentPageAccounts.length; i += 3) {
		const rowAccounts = currentPageAccounts.slice(i, i + 3)
		for (const acc of rowAccounts) {
			const isDefault = acc.id === defaultAccountId
			const isSelected = acc.id === selectedId
			const nameWithLock = frozenIds.has(acc.id) ? `${acc.name} 🔒` : acc.name
			const label = isSelected ? `✅ ${nameWithLock}` : nameWithLock
			const displayName = formatAccountName(label, isDefault)
			kb.text(displayName, `use_account:${acc.id}`)
		}
		kb.row()
	}

	if (totalPages > 1) {
		kb.text('« Назад', 'accounts_page_prev')
			.text(`${page + 1}/${totalPages}`, 'accounts_page_current')
			.text('Вперёд »', 'accounts_page_next')
			.row()
	}

	if (selectedId) {
			if (selectedFrozen) {
				kb.text('🗑 Удалить счёт', `account_delete:${selectedId}`).row()
			} else {
				kb.text('✏️ Активы', 'accounts_jarvis_edit_details')
					.text('🎨 Название', 'accounts_rename_details')
					.text('🗑 Удалить счёт', `account_delete:${selectedId}`).row()
			}
		kb.text('← Назад', 'accounts_back')
	} else {
		kb.text('➕ Добавить счёт', 'add_account').row()
		kb.text('🪄 Массовое изменение счетов', 'accounts_mass_edit_open').row()
		kb.text('← Назад', 'accounts_back')
	}

	return kb
}
