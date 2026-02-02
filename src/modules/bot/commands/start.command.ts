import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { renderHome } from '../utils/render-home'

export const startCommand = (bot: Bot<BotContext>, accountsService: AccountsService) => {
	bot.command('start', async ctx => {
		await renderHome(ctx, accountsService)
	})
}
