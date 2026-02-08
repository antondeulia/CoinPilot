import { InlineKeyboard } from 'grammy'

const PAGE_SIZE = 9

function txLabel(tx: {
	direction: string
	amount: number
	currency: string
	transactionDate: Date
	description?: string | null
	category?: string | null
}) {
	const isExpense = tx.direction === 'expense'
	const emoji = isExpense ? '🔴' : '🟢'
	const sign = isExpense ? '-' : '+'
	const date = new Date(tx.transactionDate).toLocaleDateString('ru-RU', {
		day: '2-digit',
		month: '2-digit'
	})
	const name = (tx.description ?? tx.category ?? '—').slice(0, 18)
	return `${emoji} ${name} · ${sign}${tx.amount} ${tx.currency} · ${date}`
}

export function transactionsListKeyboard(
	txs: Array<{
		id: string
		direction: string
		amount: number
		currency: string
		transactionDate: Date
		description?: string | null
		category?: string | null
	}>,
	page: number,
	totalCount: number
) {
	const kb = new InlineKeyboard()
	for (let i = 0; i < txs.length; i += 3) {
		const row = txs.slice(i, i + 3)
		for (const tx of row) {
			kb.text(txLabel(tx).slice(0, 64), `tx:${tx.id}`)
		}
		kb.row()
	}
	const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
	kb.text('« Назад', 'transactions_page:prev')
		.text(`${page + 1}/${totalPages}`, 'transactions_page:noop')
		.text('Вперёд »', 'transactions_page:next')
		.row()
		.text('← Назад', 'go_home')
	return kb
}

export function transactionDetailKeyboard() {
	return new InlineKeyboard().text('← Назад к списку', 'back_to_transactions')
}
