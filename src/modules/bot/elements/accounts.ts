import { Account } from 'generated/prisma/client'
import { InlineKeyboard } from 'grammy'
import { getCurrencySymbol, formatAccountName, formatAmount, isCryptoCurrency } from 'src/utils/format'
import { ExchangeService } from 'src/modules/exchange/exchange.service'

type AccountWithAssets = Account & {
	assets: { currency: string; amount: number }[]
}

function fmt(amount: number): string {
	return amount.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
}

export async function viewAccountsListText(
	accounts: AccountWithAssets[],
	mainCurrency: string,
	exchange: ExchangeService,
	defaultAccountId?: string
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let totalMain = 0
	let totalFiat = 0
	let totalCrypto = 0

	for (const acc of accounts) {
		let accountTotalMain = 0
		let accountFiat = 0
		let accountCrypto = 0
		for (const a of acc.assets) {
			const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
			accountTotalMain += converted
			if (isCryptoCurrency(a.currency)) {
				accountCrypto += converted
			} else {
				accountFiat += converted
			}
		}
		totalMain += accountTotalMain
		totalFiat += accountFiat
		totalCrypto += accountCrypto
	}

	const totalStr = fmt(totalMain)
	const pctFiat = totalMain > 0 ? Math.round((totalFiat / totalMain) * 100) : 0
	const pctCrypto = totalMain > 0 ? Math.round((totalCrypto / totalMain) * 100) : 0
	const fiatStr = fmt(totalFiat)
	const cryptoStr = fmt(totalCrypto)

	return `<b>Список счетов</b>

Общий баланс
${totalStr} ${mainSym}

Счетов: ${accounts.length}

Фиат: ${fiatStr} ${mainSym} (${pctFiat}%) · Крипто: ${cryptoStr} ${mainSym} (${pctCrypto}%)

<i>Все суммы приведены к основной валюте (${mainCurrency})</i>`
}

export async function accountDetailsText(
	account: AccountWithAssets,
	mainCurrency: string,
	exchange: ExchangeService,
	isDefault: boolean = false
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let balanceMain = 0
	const lines: string[] = []

	for (const a of account.assets) {
		const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
		balanceMain += converted
		const amountStr = formatAmount(a.amount, a.currency)
		if (a.currency === mainCurrency) {
			lines.push(`${a.currency} — ${amountStr}`)
		} else {
			lines.push(`${a.currency} — ${amountStr} (≈ ${fmt(converted)} ${mainSym})`)
		}
	}

	const balanceStr = fmt(balanceMain)
	return `<b>${escapeHtml(formatAccountName(account.name, isDefault))}</b>

Баланс: ${balanceStr} ${mainSym}

${lines.length > 0 ? lines.join('\n') : '— нет активов'}`
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function viewAccountsText(
	accounts: AccountWithAssets[],
	mainCurrency: string,
	exchange: ExchangeService,
	defaultAccountId?: string
): Promise<string> {
	const mainSym = getCurrencySymbol(mainCurrency)
	let totalMain = 0
	const blocks: string[] = []

	for (const acc of accounts) {
		let accountTotalMain = 0
		const lines: string[] = []
		for (const a of acc.assets) {
			const converted = await exchange.convert(a.amount, a.currency, mainCurrency)
			accountTotalMain += converted
			const amountStr = formatAmount(a.amount, a.currency)
			if (a.currency === mainCurrency) {
				lines.push(`• ${a.currency} — ${amountStr}`)
			} else {
				lines.push(`• ${a.currency} — ${amountStr} ≈ ${fmt(converted)} ${mainSym}`)
			}
		}
		totalMain += accountTotalMain
		const accountTotalStr = fmt(accountTotalMain)
		const body =
			lines.length > 0 ? lines.join('\n') : '— нет активов'
		const accountLine =
			acc.assets.length > 0
				? `Итого: ${accountTotalStr} ${mainSym}`
				: `Итого: 0.00 ${mainSym}`
		const isDefault = acc.id === defaultAccountId
		blocks.push(`🏦 ${formatAccountName(acc.name, isDefault)}\n${accountLine}\n\n${body}`)
	}

	const totalStr = fmt(totalMain)
	const header = `📂 Список счетов

💼 Всего по всем счетам:
${totalStr} ${mainSym}

`

	const footer = `
ℹ️ Примечания

• Все суммы приведены к основной валюте (${mainCurrency})
• Курсы обновляются автоматически
`
	return header + blocks.join('\n\n') + footer
}

export function accountsKeyboard(accounts: Account[], activeId: string | null, defaultAccountId?: string) {
	const kb = new InlineKeyboard()

	for (const acc of accounts) {
		const isDefault = acc.id === defaultAccountId
		kb.text(
			`${acc.id === activeId ? '👉 ' : ''}${formatAccountName(acc.name, isDefault)} (${acc.currency})`,
			`use_account:${acc.id}`
		).row()
	}

	kb.text('➕ Добавить счёт', 'add_account')

	return kb
}
