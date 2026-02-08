import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'

export const addAccountCallback = (bot: Bot<BotContext>) => {
	bot.callbackQuery('add_account', async ctx => {
		ctx.session.awaitingAccountInput = true
		ctx.session.confirmingAccounts = false
		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined

		const msg = await ctx.reply(
			`➕ <b>Добавь счёт</b>

Например:
monobank 3k EUR 500k UAH and 30k usd, Wise 1000 GBP`,
			{
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard().text('Закрыть', 'close_add_account')
			}
		)

		ctx.session.tempMessageId = msg.message_id
	})
}
