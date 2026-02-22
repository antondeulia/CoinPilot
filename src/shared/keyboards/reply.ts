import { Keyboard } from 'grammy'

export function appReplyKeyboard(showHelp = false) {
	const kb = new Keyboard()
		.text('➕ Добавить транзакцию')
		.text('🏠 На главное меню')
		.resized()
		.persistent()
	if (showHelp) {
		kb.row().text('❓ Помощь')
	}
	return kb
}
