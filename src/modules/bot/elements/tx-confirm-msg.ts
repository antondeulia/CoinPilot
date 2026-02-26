import { LlmTransaction } from '../../../modules/llm/schemas/transaction.schema'
import {
	formatByCurrencyPolicy,
	formatExactAmount,
	getCurrencySymbol,
	formatAccountName,
	roundByCurrencyPolicy,
	getCurrencyFractionDigits
} from '../../../utils/format'
import { formatTransactionDate } from '../../../utils/date'

function formatDirection(direction: LlmTransaction['direction']) {
	if (direction === 'expense') return '🔴 Расход'
	if (direction === 'income') return '🟢 Доход'
	if (direction === 'transfer') return '🔄 Перевод'
	return '—'
}

export function renderConfirmMessage(
	tx: LlmTransaction,
	index?: number,
	total?: number,
	defaultAccountId?: string,
	tagInfo?: { name: string; isNew: boolean },
	title: string = 'Просмотр транзакций'
) {
	const draft = tx as any
	const tagName = tagInfo?.name ?? draft?.tagName ?? ''
	const tagIsNew = tagInfo?.isNew ?? draft?.tagIsNew ?? false
	const tagSessionNew = Boolean(draft?.tagWasNewInSession)
	const tagLine =
		tagName.length > 0
			? `Тег:\n<blockquote>${tagName}${tagIsNew || tagSessionNew ? ' (новый)' : ''}</blockquote>`
			: 'Тег: -'
	const roundedAmount =
		typeof tx.amount === 'number' ? roundByCurrencyPolicy(Math.abs(tx.amount), tx.currency ?? '') : 0
	const amountText =
		typeof tx.amount === 'number' && tx.currency
			? formatExactAmount(roundedAmount, tx.currency, {
					maxFractionDigits: getCurrencyFractionDigits(tx.currency),
					trimTrailingZeros: true
				})
			: '—'
	const signPrefix =
		tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : ''
	const isDeletedCurrency = !!(draft as any).currencyDeleted

	const date = tx.transactionDate ? new Date(tx.transactionDate) : new Date()
	const timezone = (draft.userTimezone as string | undefined) ?? 'UTC+02:00'
	const dateText = formatTransactionDate(date, timezone)
	const isDetailsTitle = title.toLowerCase().includes('детали транзакции')
	const hasMany = typeof total === 'number' && total > 1
	const resolvedTitle = isDetailsTitle
		? 'Детали транзакции'
		: hasMany
			? 'Просмотр транзакций'
			: 'Просмотр транзакции'
	const headerIndex =
		!isDetailsTitle && hasMany && typeof index === 'number'
			? ` ${index + 1}/${total}`
			: ''

	let amountLine = `Сумма: ${signPrefix}${amountText}`
	if (isDeletedCurrency) {
		amountLine = `Сумма: <s>${signPrefix}${amountText}</s> <code>deleted</code>`
	}
	if (
		typeof tx.amount === 'number' &&
		tx.currency &&
		tx.convertToCurrency &&
		tx.convertedAmount != null &&
		tx.currency !== tx.convertToCurrency &&
		!isDeletedCurrency
	) {
		const sym = getCurrencySymbol(tx.convertToCurrency)
		const convertedStr = formatByCurrencyPolicy(
			Math.abs(tx.convertedAmount),
			tx.convertToCurrency,
			undefined,
			{ withSymbol: false }
		)
		amountLine = `Сумма: ${signPrefix}${amountText} (→ ${convertedStr} ${sym})`
	}

	const isTransfer = tx.direction === 'transfer'
	const categoryLine = isTransfer ? '' : `Категория: ${tx.category ?? '—'}\n`
	const targetAccountName =
		(draft.toAccount as string) ??
		((draft.toAccountId as string | undefined) ? 'Вне Wallet' : '—')
	const targetAccountLine = isTransfer
		? `На счёт: ${formatAccountName(targetAccountName, false)}\n`
		: ''
	const balanceAfterLine = draft.balanceAfterText
		? `\n<code>После операции баланс счёта: ${draft.balanceAfterText}</code>`
		: ''

	return `
	📄 <b>${resolvedTitle}${headerIndex}</b>

${formatDirection(tx.direction)}
${tx.description ?? '—'}

${amountLine}
Счёт: ${formatAccountName(tx.account ?? '—', tx.accountId === defaultAccountId)}
${targetAccountLine}Дата: ${dateText}
${categoryLine}${tagLine}
${balanceAfterLine}`.trim()
}
