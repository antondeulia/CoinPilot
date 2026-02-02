import { LlmTransaction } from 'src/modules/llm/schemas/transaction.schema'

export function renderConfirmMessage(tx: LlmTransaction) {
	return `
<b>Проверь транзакцию</b>

Название: ${tx.description ?? '—'}
Сумма: ${tx.amount ?? '—'} ${tx.currency ?? ''}
Дата: ${new Date().toLocaleDateString('ru-RU')}
Категория: ${tx.category ?? '—'}
`
}
