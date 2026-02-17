import { InlineKeyboard } from 'grammy'

export function homeText(
	totalBalance: number,
	mainCurrency: string,
	accountsCount: number,
	monthlyChangePct: number
) {
	const balanceStr = totalBalance.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
	const accountsStr = accountsCount.toLocaleString('ru-RU')
	const pct =
		Number.isFinite(monthlyChangePct) && !Number.isNaN(monthlyChangePct)
			? monthlyChangePct
			: 0
	const pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'

	return `<b>CoinPilot AI – бот по управлению капиталом.</b>

💰 Общий капитал: <i>${balanceStr} ${mainCurrency}</i>
🏦 Счетов: <i>${accountsStr}</i>
📈 30 дней: <i>${pctStr}</i>

Выберите действие в меню ниже.

<code>🧠 AI-ассистент активен
🔒 Данные зашифрованы</code>`
}

export function homeKeyboard() {
	return new InlineKeyboard()
		.text('➕ Добавить транзакцию', 'add_transaction')
		.text('💼 Счета', 'view_accounts')
		.row()
		.text('📄 Список транзакций', 'view_transactions')
		.text('📊 Аналитика', 'view_analytics')
		.row()
		.text('⚙️ НастройкиААААА', 'view_settings')
}
