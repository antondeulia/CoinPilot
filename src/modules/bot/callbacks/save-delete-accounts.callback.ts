import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { UsersService } from '../../../modules/users/users.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { FREE_LIMITS } from '../../../modules/subscription/subscription.constants'
import { refreshAccountsPreview } from './accounts-preview.callback'
import { PremiumEventType } from '../../../generated/prisma/enums'
import { ExchangeService } from '../../../modules/exchange/exchange.service'
import { viewAccountsListText } from '../elements/accounts'
import { accountSwitchKeyboard } from '../../../shared/keyboards'

const UPSELL_ACCOUNTS =
	'💠 Вы достигли лимита — 2 счета в Free. Перейдите на Premium и управляйте финансами без ограничений!'
const UPSELL_ASSETS = `💠 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Free. Разблокируйте безлимит с Premium!`

export const saveDeleteAccountsCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	usersService: UsersService,
	subscriptionService: SubscriptionService,
	analyticsService: AnalyticsService,
	exchangeService: ExchangeService
) => {
	const refreshAccountsPanel = async (ctx: BotContext) => {
		const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
		;(ctx.state as any).user = user
		;(ctx.state as any).activeAccount =
			user.accounts.find(a => a.id === user.activeAccountId) ?? null
		const [accountsWithAssets, frozen] = await Promise.all([
			accountsService.getAllWithAssets(user.id),
			subscriptionService.getFrozenItems(user.id)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
		const visibleAccounts = (user.accounts ?? []).filter(
			(a: { isHidden?: boolean }) => !a.isHidden
		)
		const text = await viewAccountsListText(
			accountsWithAssets,
			user.mainCurrency ?? 'USD',
			exchangeService,
			analyticsService,
			user.id,
			(user as any).lastTipText
		)
		await ctx.api.editMessageText(ctx.chat!.id, ctx.session.homeMessageId, text, {
			parse_mode: 'HTML',
			reply_markup: accountSwitchKeyboard(
				visibleAccounts,
				user.activeAccountId,
				ctx.session.accountsViewPage ?? 0,
				null,
				user.defaultAccountId ?? undefined,
				frozenAccountIds
			)
		})
	}
	bot.callbackQuery('confirm_1_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		const index = ctx.session.currentAccountIndex ?? 0

		if (!drafts || !drafts.length) return

		const draft = drafts[index]
		const lockKey = JSON.stringify({
			name: draft?.name ?? '',
			assets: (draft?.assets ?? [])
				.map(a => `${a.currency}:${a.amount}`)
				.sort()
		})
		const sessionAny = ctx.session as any
		const singleLocks: string[] = sessionAny.savingAccountLocks ?? []
		if (singleLocks.includes(lockKey)) return
		sessionAny.savingAccountLocks = [...singleLocks, lockKey]

		const limitAccount = await subscriptionService.canCreateAccount(ctx.state.user.id)
		if (!limitAccount.allowed) {
			sessionAny.savingAccountLocks = (sessionAny.savingAccountLocks ?? []).filter(
				(k: string) => k !== lockKey
			)
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'accounts'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS })
			await ctx.reply(UPSELL_ACCOUNTS, {
				reply_markup: new InlineKeyboard()
					.text('💠 Pro-тариф', 'view_premium')
					.row()
					.text('Закрыть', 'hide_message')
			})
			return
		}
		if (
			!ctx.state.isPremium &&
			draft.assets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT
		) {
			sessionAny.savingAccountLocks = (sessionAny.savingAccountLocks ?? []).filter(
				(k: string) => k !== lockKey
			)
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'assets'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ASSETS })
			await ctx.reply(UPSELL_ASSETS, {
				reply_markup: new InlineKeyboard()
					.text('💠 Pro-тариф', 'view_premium')
					.row()
					.text('Закрыть', 'hide_message')
			})
			return
		}

		try {
			await accountsService.createAccountWithAssets(ctx.state.user.id, draft)
		} catch {
			sessionAny.savingAccountLocks = (sessionAny.savingAccountLocks ?? []).filter(
				(k: string) => k !== lockKey
			)
			return
		}

		drafts.splice(index, 1)
		sessionAny.savingAccountLocks = (sessionAny.savingAccountLocks ?? []).filter(
			(k: string) => k !== lockKey
		)

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
			const hintId = (ctx.session as any).accountInputHintMessageId
			if (hintId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, hintId)
				} catch {}
				;(ctx.session as any).accountInputHintMessageId = undefined
			}
			;(ctx.session as any).accountInputMessageIds = []

			await ctx.reply(`✅ Счёт сохранён: ${draft.name}`, {
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			})
			await refreshAccountsPanel(ctx)
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
			const hintId = (ctx.session as any).accountInputHintMessageId
			if (hintId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, hintId)
				} catch {}
				;(ctx.session as any).accountInputHintMessageId = undefined
			}
			;(ctx.session as any).accountInputMessageIds = []

			return
		}

		ctx.session.currentAccountIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshAccountsPreview(ctx)
	})

	bot.callbackQuery('confirm_all_accounts', async ctx => {
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return
		const sessionAny = ctx.session as any
		if (sessionAny.savingAllAccounts) return
		sessionAny.savingAllAccounts = true

		const limitAccount = await subscriptionService.canCreateAccount(ctx.state.user.id)
		if (!limitAccount.allowed) {
			sessionAny.savingAllAccounts = false
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'accounts'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS })
			await ctx.reply(UPSELL_ACCOUNTS, {
				reply_markup: new InlineKeyboard()
					.text('💠 Pro-тариф', 'view_premium')
					.row()
					.text('Закрыть', 'hide_message')
			})
			return
		}
		const wouldExceedAccounts =
			!ctx.state.isPremium &&
			limitAccount.current + drafts.length > limitAccount.limit
		if (wouldExceedAccounts) {
			sessionAny.savingAllAccounts = false
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'accounts'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS })
			await ctx.reply(UPSELL_ACCOUNTS, {
				reply_markup: new InlineKeyboard()
					.text('💠 Pro-тариф', 'view_premium')
					.row()
					.text('Закрыть', 'hide_message')
			})
			return
		}
		const hasOverLimitAssets =
			!ctx.state.isPremium &&
			drafts.some(d => d.assets.length > FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT)
		if (hasOverLimitAssets) {
			sessionAny.savingAllAccounts = false
			await subscriptionService.trackEvent(
				ctx.state.user.id,
				PremiumEventType.limit_hit,
				'assets'
			)
			await ctx.answerCallbackQuery({ text: UPSELL_ASSETS })
			await ctx.reply(UPSELL_ASSETS, {
				reply_markup: new InlineKeyboard()
					.text('💠 Pro-тариф', 'view_premium')
					.row()
					.text('Закрыть', 'hide_message')
			})
			return
		}

		ctx.session.draftAccounts = undefined
		let created = 0
		const createdNames: string[] = []
		for (const draft of drafts) {
			try {
				await accountsService.createAccountWithAssets(ctx.state.user.id, draft)
				created++
				if (draft?.name) createdNames.push(draft.name)
			} catch {}
		}

		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false
		ctx.session.awaitingAccountInput = false

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
		const hintId = (ctx.session as any).accountInputHintMessageId
		if (hintId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, hintId)
			} catch {}
			;(ctx.session as any).accountInputHintMessageId = undefined
		}
		;(ctx.session as any).accountInputMessageIds = []

		await ctx.reply(
			created > 0
				? `✅ Счета сохранены: ${createdNames.join(', ')}`
				: 'Не удалось сохранить счета.',
			{
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			}
		)
		await refreshAccountsPanel(ctx)
		sessionAny.savingAllAccounts = false
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
		const hintId = (ctx.session as any).accountInputHintMessageId
		if (hintId != null) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, hintId)
			} catch {}
			;(ctx.session as any).accountInputHintMessageId = undefined
		}
		;(ctx.session as any).accountInputMessageIds = []
	})
}
