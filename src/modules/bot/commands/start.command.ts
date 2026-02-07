import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { renderHome } from '../utils/render-home'

export const startCommand = (bot: Bot<BotContext>, accountsService: AccountsService) => {
	bot.command('start', async ctx => {
		;(ctx.session as any).editingCurrency = false
		;(ctx.session as any).editingMainCurrency = false
		ctx.session.editingField = undefined
		ctx.session.editMessageId = undefined
		ctx.session.accountsPage = undefined
		ctx.session.accountsViewPage = undefined
		ctx.session.accountsViewSelectedId = undefined
		ctx.session.editingAccountField = undefined
		ctx.session.editingAccountDetailsId = undefined
		ctx.session.categoriesPage = undefined
		ctx.session.categoriesSelectedId = undefined
		await renderHome(ctx, accountsService)
	})
}
