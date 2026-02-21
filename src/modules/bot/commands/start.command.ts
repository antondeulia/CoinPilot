import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { renderHome } from '../utils/render-home'

export const startCommand = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	analyticsService: AnalyticsService
) => {
	bot.command('start', async ctx => {
		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
		}
		;(ctx.session as any).editingCurrency = false
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingTimezone = false
		ctx.session.editingField = undefined
		ctx.session.editMessageId = undefined
		ctx.session.accountsPage = undefined
		ctx.session.accountsViewPage = undefined
		ctx.session.accountsViewSelectedId = undefined
		ctx.session.editingAccountField = undefined
		ctx.session.editingAccountDetailsId = undefined
		ctx.session.categoriesPage = undefined
		ctx.session.categoriesSelectedId = undefined
		ctx.session.awaitingTransaction = false
		;(ctx.session as any).awaitingTagInput = false
		;(ctx.session as any).awaitingTagsJarvisEdit = false
		ctx.session.awaitingAccountInput = false
		;(ctx.session as any).awaitingCategoryName = false
		ctx.session.confirmingTransaction = false
		;(ctx.session as any).confirmingAccounts = false
		ctx.session.draftTransactions = undefined
		;(ctx.session as any).draftAccounts = undefined
		ctx.session.currentTransactionIndex = undefined
		;(ctx.session as any).currentAccountIndex = undefined
		ctx.session.tempMessageId = undefined
		ctx.session.navigationStack = undefined
		ctx.session.tagsPage = undefined
		;(ctx.session as any).editingCategory = undefined
		;(ctx.session as any).tagsSettingsMessageId = undefined
		;(ctx.session as any).tagsSettingsHintMessageId = undefined
		;(ctx.session as any).editingTransactionId = undefined
		;(ctx.session as any).timezoneHintMessageId = undefined
		;(ctx.session as any).timezoneErrorMessageIds = undefined
		;(ctx.session as any).accountDeltaPromptMessageId = undefined
		;(ctx.session as any).pendingAccountDeltaOps = undefined
		await renderHome(ctx, accountsService, analyticsService)
	})
}
