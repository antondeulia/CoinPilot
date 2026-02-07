import { AccountsService } from 'src/modules/accounts/accounts.service'
import { BotContext } from '../core/bot.middleware'
import { homeKeyboard, homeText } from 'src/shared/keyboards/home'

export async function renderHome(ctx: BotContext, accountsService: AccountsService) {
	;(ctx.session as any).editingCurrency = false
	;(ctx.session as any).editingMainCurrency = false
	ctx.session.editingField = undefined
	const account = ctx.state.activeAccount

	const balance = await accountsService.getBalance({
		userId: ctx.state.user.id
	})

	let msg: any
	try {
		msg = await ctx.reply(homeText(account, balance), {
			parse_mode: 'HTML',
			reply_markup: homeKeyboard(account, balance)
		})
	} catch (error) {
		console.log(error)
	}


	ctx.session.homeMessageId = msg.message_id
}
