import { AccountsService } from 'src/modules/accounts/accounts.service'
import { BotContext } from '../core/bot.middleware'
import { homeKeyboard, homeText } from 'src/shared/keyboards/home'

export async function renderHome(ctx: BotContext, accountsService: AccountsService) {
	console.log('Hi')
	console.log()
	const account = ctx.state.activeAccount

	console.log(account, ' <- Account', ctx.state.user)

	const balance = await accountsService.getBalance({
		userId: ctx.state.user.id
	})

	console.log(ctx.session.homeMessageId)
	if (ctx.session.homeMessageId) {
		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.homeMessageId,
				homeText(account, balance),
				{
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance)
				}
			)
			return
		} catch {}
	}

	let msg: any

	try {
		console.log('before')
		msg = await ctx.reply(homeText(account, balance), {
			parse_mode: 'HTML',
			reply_markup: homeKeyboard(account, balance)
		})
		console.log('after')
	} catch (error) {
		console.log(error)
	}

	console.log('after call')

	ctx.session.homeMessageId = msg.message_id
}
