import { InlineKeyboard } from 'grammy'

export const mainMenu = new InlineKeyboard()
	.text('Текущий счет: MonoBank White', 'current_account')
	.text('Баланс: 795 UAH', 'current_balance')
	.row()
	.text('📊 Транзакции', 'transactions')
	.text('📊 Аналитика')
	.row()
	.text('⚙️ Настройки')
