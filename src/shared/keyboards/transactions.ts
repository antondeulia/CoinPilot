import { InlineKeyboard } from 'grammy'

export function transactionsKeyboard(txs) {
	const kb = new InlineKeyboard()

	for (const tx of txs) {
		const isExpense = tx.direction === 'expense'
		const emoji = isExpense ? '🔴' : '🟢'
		const sign = isExpense ? '-' : '+'

		const date = new Date(tx.createdAt).toLocaleDateString('ru-RU', {
			day: '2-digit',
			month: '2-digit'
		})

		const name = (tx.description ?? tx.category ?? '—').slice(0, 18)

		const label = `${emoji} ${name} · ${sign}${tx.amount} ${tx.currency} · ${date}`

		kb.text(label, `tx:${tx.id}`).row()
	}

	kb.text('⬅️ Скрыть', 'hide_message')
	return kb
}
