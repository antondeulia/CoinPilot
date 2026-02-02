export function accountInfoText(acc) {
	return `<b>${acc.name}</b>
Валюта: ${acc.currency}
Тип: ${acc.type ?? 'cash'}`
}

export function formatTransactionMessage(tx: {
	direction: 'income' | 'expense'
	amount: number
	currency: string
	category?: string
	description?: string
	createdAt?: Date
}) {
	const type = tx.direction === 'expense' ? 'Расход' : 'Доход'

	const date = (tx.createdAt ?? new Date()).toLocaleString('ru-RU', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	})

	return `
<b>Новая транзакция создана! ✅</b>

<b>Тип:</b> ${type}
<b>Сумма:</b> ${tx.amount} ${tx.currency}
<b>Категория:</b> ${tx.category ?? '—'}
<b>Описание:</b> ${tx.description ?? '—'}
<b>Дата:</b> ${date}
`
}
