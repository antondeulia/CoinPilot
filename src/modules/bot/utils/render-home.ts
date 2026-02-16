import { AccountsService } from '../../../modules/accounts/accounts.service'
import { BotContext } from '../core/bot.middleware'
import { homeKeyboard, homeText } from '../../../shared/keyboards/home'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'

export async function renderHome(
	ctx: BotContext,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
) {
	;(ctx.session as any).editingCurrency = false
	;(ctx.session as any).editingMainCurrency = false
	ctx.session.editingField = undefined
	const user: any = ctx.state.user
	const mainCurrency = user?.mainCurrency ?? 'USD'
	const accounts = (user?.accounts ?? []).filter(
		(a: { isHidden?: boolean }) => !a.isHidden
	)
	const accountsCount = accounts.length
	let totalBalance = 0
	let monthlyChangePct = 0
	try {
		const [summary, cashflow] = await Promise.all([
			analyticsService.getSummary(user.id, '30d', mainCurrency),
			analyticsService.getCashflow(user.id, '30d', mainCurrency)
		])
		totalBalance = summary.balance
		const beginning = summary.balance - cashflow
		if (beginning > 0) {
			monthlyChangePct = (cashflow / beginning) * 100
		}
	} catch {}

	let msg: any
	try {
		msg = await ctx.reply(
			homeText(totalBalance, mainCurrency, accountsCount, monthlyChangePct),
			{
				parse_mode: 'HTML',
				disable_web_page_preview: true,
				reply_markup: homeKeyboard()
			} as any
		)
	} catch (error) {
		console.log(error)
	}

	ctx.session.homeMessageId = msg.message_id
}
