import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { UsersService } from '../../../modules/users/users.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { FREE_LIMITS } from '../../../modules/subscription/subscription.constants'
import { refreshAccountsPreview } from './accounts-preview.callback'
import { homeKeyboard, homeText } from '../../../shared/keyboards/home'
import { PremiumEventType } from '../../../generated/prisma/enums'

const UPSELL_ACCOUNTS =
	'👑 Вы достигли лимита — 2 счета в Free. Перейдите на Premium и управляйте финансами без ограничений!'
const UPSELL_ASSETS = `👑 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Free. Разблокируйте безлимит с Premium!`

export const saveDeleteAccountsCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	usersService: UsersService,
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('confirm_1_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		const index = ctx.session.currentAccountIndex ?? 0

		if (!drafts || !drafts.length) return

		const draft = drafts[index]

		const limitAccount = await subscriptionService.canCreateAccount(ctx.state.user.id)
		if (!limitAccount.allowed) {
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'accounts'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS })
			await ctx.reply(UPSELL_ACCOUNTS, {
				reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
			})
			return
		}
		if (
			!ctx.state.isPremium &&
			draft.assets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
		) {
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'assets'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ASSETS })
			await ctx.reply(UPSELL_ASSETS, {
				reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
			})
			return
		}

		await accountsService.createAccountWithAssets(ctx.state.user.id, draft)

		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftAccounts = undefined
			ctx.session.currentAccountIndex = undefined
			ctx.session.confirmingAccounts = false
			ctx.session.awaitingAccountInput = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}

			await ctx.reply('Счёт сохранён.')

			const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
			const account = user.accounts.find(a => a.id === user.activeAccountId)
			if (account) {
				const mainCurrency = (user as any).mainCurrency ?? 'USD'
				const balance = await accountsService.getBalance({
					userId: user.id,
					mainCurrency
				})
				const homeMsg = await ctx.reply(homeText(account, balance), {
					parse_mode: 'HTML',
					reply_markup: homeKeyboard(account, balance, mainCurrency)
				})
				ctx.session.homeMessageId = homeMsg.message_id
			}
			return
		}

		ctx.session.currentAccountIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('cancel_1_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		const index = ctx.session.currentAccountIndex ?? 0

		if (!drafts || !drafts.length) return

		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftAccounts = undefined
			ctx.session.currentAccountIndex = undefined
			ctx.session.confirmingAccounts = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}

			return
		}

		ctx.session.currentAccountIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('confirm_all_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return

		const limitAccount = await subscriptionService.canCreateAccount(ctx.state.user.id)
		if (!limitAccount.allowed) {
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'accounts'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS })
			await ctx.reply(UPSELL_ACCOUNTS, {
				reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
			})
			return
		}
		const wouldExceedAccounts =
			!ctx.state.isPremium &&
			limitAccount.current + drafts.length > limitAccount.limit
		if (wouldExceedAccounts) {
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'accounts'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS })
			await ctx.reply(UPSELL_ACCOUNTS, {
				reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
			})
			return
		}
		const hasOverLimitAssets =
			!ctx.state.isPremium &&
			drafts.some(d => d.assets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT)
		if (hasOverLimitAssets) {
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'assets'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ASSETS })
			await ctx.reply(UPSELL_ASSETS, {
				reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
			})
			return
		}

		for (const draft of drafts) {
			await accountsService.createAccountWithAssets(ctx.state.user.id, draft)
		}

		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false
		ctx.session.awaitingAccountInput = false

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}

		await ctx.reply('Все счета сохранены.')

		const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
		const account = user.accounts.find(a => a.id === user.activeAccountId)
		if (account) {
			const mainCurrency = (user as any).mainCurrency ?? 'USD'
			const balance = await accountsService.getBalance({
				userId: user.id,
				mainCurrency
			})
			const homeMsg = await ctx.reply(homeText(account, balance), {
				parse_mode: 'HTML',
				reply_markup: homeKeyboard(account, balance, mainCurrency)
			})
			ctx.session.homeMessageId = homeMsg.message_id
		}
	})

	bot.callbackQuery('cancel_all_accounts', async ctx => {
		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
	})
}
