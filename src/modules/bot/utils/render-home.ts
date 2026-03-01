import { AccountsService } from '../../../modules/accounts/accounts.service'
import { BotContext } from '../core/bot.middleware'
import { homeKeyboard, homeText } from '../../../shared/keyboards/home'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { appReplyKeyboard } from '../../../shared/keyboards/reply'

export async function renderHome(
	ctx: BotContext,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
) {
	const quickMenuId = (ctx.session as any).quickMenuMessageId as number | undefined
	if (quickMenuId != null) {
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, quickMenuId)
		} catch {}
		;(ctx.session as any).quickMenuMessageId = undefined
	}
	;(ctx.session as any).editingCurrency = false
	;(ctx.session as any).editingMainCurrency = false
	ctx.session.editingField = undefined
	const user: any = ctx.state.user
	const mainCurrency = user?.mainCurrency ?? 'USD'
	const visibleAccounts = user?.id
		? await accountsService.getAllByUserId(user.id)
		: []
	const accountsCount = visibleAccounts.length
	let totalBalance = 0
	let monthlyChangePct = Number.NaN
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
	const nextHomeText = homeText(
		totalBalance,
		mainCurrency,
		accountsCount,
		monthlyChangePct
	)
	const existingHomeId = ctx.session.homeMessageId
	if (existingHomeId != null) {
		try {
			await ctx.api.editMessageText(ctx.chat!.id, existingHomeId, nextHomeText, {
				parse_mode: 'HTML',
				disable_web_page_preview: true,
				reply_markup: homeKeyboard()
			} as any)
			msg = { message_id: existingHomeId }
		} catch (error) {
			const message = String((error as Error)?.message ?? '')
			if (message.includes('message is not modified')) {
				msg = { message_id: existingHomeId }
			} else {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, existingHomeId)
				} catch {}
			}
		}
	}
	if (!msg) {
		try {
			msg = await ctx.reply(nextHomeText, {
				parse_mode: 'HTML',
				disable_web_page_preview: true,
				reply_markup: homeKeyboard()
			} as any)
		} catch (error) {
			console.log(error)
		}
	}

	if (msg?.message_id != null) {
		ctx.session.homeMessageId = msg.message_id
	}

	try {
		const quick = await ctx.reply('Быстрые действия 👇', {
			reply_markup: appReplyKeyboard(true)
		} as any)
		;(ctx.session as any).quickMenuMessageId = quick.message_id
	} catch {}
}
