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
import { renderHome } from '../utils/render-home'

const UPSELL_ACCOUNTS =
	'💠 Вы достигли лимита — 2 счета в Basic. Перейдите на Pro и управляйте финансами без ограничений!'
const UPSELL_ASSETS = `💠 На одном счёте можно до ${FREE_LIMITS.MAX_ASSETS_PER_ACCOUNT} валют в Basic. Разблокируйте безлимит с Pro!`
const TRIAL_DAY1_TEXT = `🎉 Отличный шаг. Добавив два счёта, ты активировал 7 дней Pro-доступа.

Теперь у тебя открыты инструменты, которые позволяют вести финансы так, как это делают системные инвесторы:
• неограниченные транзакции и счета
• глубокая аналитика
• собственные категории и теги
• экспорт данных
• будущие Pro-модули

Используй этот период, чтобы увидеть, как удобно управлять капиталом, и почувствовать контроль над деньгами.`

export const saveDeleteAccountsCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	usersService: UsersService,
	subscriptionService: SubscriptionService,
	analyticsService: AnalyticsService,
	exchangeService: ExchangeService
) => {
	const deleteMessageBestEffort = async (
		ctx: BotContext,
		messageId?: number
	): Promise<void> => {
		if (messageId == null) return
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, messageId)
		} catch {}
	}

	const answerCallbackBestEffort = async (ctx: BotContext): Promise<void> => {
		try {
			await ctx.answerCallbackQuery()
		} catch {}
	}

	const extractTelegramErrorMessage = (error: unknown): string => {
		const maybeAny = error as any
		return String(maybeAny?.description ?? maybeAny?.message ?? maybeAny ?? '').toLowerCase()
	}

	const isTelegramNotModified = (error: unknown): boolean =>
		extractTelegramErrorMessage(error).includes('message is not modified')

	const shouldTelegramEditFallback = (error: unknown): boolean => {
		const msg = extractTelegramErrorMessage(error)
		return (
			msg.includes('message to edit not found') ||
			msg.includes("message can't be edited") ||
			msg.includes('query is too old') ||
			msg.includes('message_id_invalid')
		)
	}

	const closeAccountInputHints = async (ctx: BotContext): Promise<void> => {
		const hintId = (ctx.session as any).accountInputHintMessageId as number | undefined
		if (hintId != null) {
			await deleteMessageBestEffort(ctx, hintId)
			;(ctx.session as any).accountInputHintMessageId = undefined
		}
		;(ctx.session as any).accountInputMessageIds = []
	}

	const closePreviewMessage = async (ctx: BotContext): Promise<void> => {
		if (ctx.session.tempMessageId == null) return
		await deleteMessageBestEffort(ctx, ctx.session.tempMessageId)
		ctx.session.tempMessageId = undefined
	}

	const cleanupOnboardingMessagesAfterTwoAccounts = async (
		ctx: BotContext
	): Promise<void> => {
		const visibleAccounts = await accountsService.getAllByUserId(ctx.state.user.id)
		if (visibleAccounts.length < FREE_LIMITS.MAX_ACCOUNTS) return
		await deleteMessageBestEffort(ctx, ctx.session.onboardingAccountsMessageId)
		await deleteMessageBestEffort(ctx, ctx.session.onboardingStartMessageId)
		ctx.session.onboardingAccountsMessageId = undefined
		ctx.session.onboardingStartMessageId = undefined
	}

	const refreshAccountsPanel = async (ctx: BotContext): Promise<void> => {
		const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
		;(ctx.state as any).user = user
		;(ctx.state as any).activeAccount =
			user.accounts.find(a => a.id === user.activeAccountId) ?? null
		;(ctx.state as any).isPremium = subscriptionService.isPremium(user as any)

		const [accountsWithAssets, frozen] = await Promise.all([
			accountsService.getAllWithAssets(user.id),
			subscriptionService.getFrozenItems(user.id)
		])
		const frozenAccountIds = new Set(frozen.accountIdsOverLimit)
			const visibleAccounts = await accountsService.getAllByUserId(user.id)
			const text = await viewAccountsListText(
				accountsWithAssets,
				user.mainCurrency ?? 'USD',
				exchangeService,
				analyticsService,
				user.id,
				(user as any).lastTipText,
				ctx.session.accountsViewExpanded ?? false
			)
		const extra = {
			parse_mode: 'HTML' as const,
			reply_markup: accountSwitchKeyboard(
				visibleAccounts,
				user.activeAccountId,
					ctx.session.accountsViewPage ?? 0,
					null,
					user.defaultAccountId ?? undefined,
					frozenAccountIds,
					false,
					ctx.session.accountsViewExpanded ?? false
				)
			}
		const targetMessageId = ctx.session.homeMessageId
		if (targetMessageId == null) {
			const msg = await ctx.reply(text, extra)
			ctx.session.homeMessageId = msg.message_id
			return
		}
		try {
			await ctx.api.editMessageText(ctx.chat!.id, targetMessageId, text, extra)
		} catch (error: unknown) {
			if (!isTelegramNotModified(error) && shouldTelegramEditFallback(error)) {
				const msg = await ctx.reply(text, extra)
				ctx.session.homeMessageId = msg.message_id
			}
		}
	}

	const refreshStartPanel = async (ctx: BotContext): Promise<void> => {
		const user = await usersService.getOrCreateByTelegramId(String(ctx.from!.id))
		;(ctx.state as any).user = user
		;(ctx.state as any).activeAccount =
			user.accounts.find(a => a.id === user.activeAccountId) ?? null
		;(ctx.state as any).isPremium = subscriptionService.isPremium(user as any)
		;(ctx.session as any).homeMessageId = undefined
		await renderHome(ctx as any, accountsService, analyticsService)
	}

	const normalizeCurrencyCode = (raw: string): string => {
		const compact = String(raw ?? '')
			.trim()
			.toUpperCase()
			.replace(/\s+/g, '')
		const aliases: Record<string, string> = {
			'$': 'USD',
			'€': 'EUR',
			'₴': 'UAH',
			'₽': 'RUB',
			'£': 'GBP',
			ЕВРО: 'EUR',
			ГРН: 'UAH',
			ГРИВНА: 'UAH',
			BYP: 'BYN',
			BYR: 'BYN'
		}
		return aliases[compact] ?? compact
	}

	const validateDraftCurrencies = async (
		drafts: Array<{ assets: Array<{ currency: string }> }>
	): Promise<string | null> => {
		const known = await exchangeService.getKnownCurrencies()
		const supported = new Set<string>([
			...Array.from(known.fiat),
			...Array.from(known.crypto)
		])
		for (const draft of drafts) {
			for (const asset of draft.assets ?? []) {
				const code = normalizeCurrencyCode(asset.currency)
				if (!code || !supported.has(code)) {
					return String(asset.currency ?? '').toUpperCase() || 'UNKNOWN'
				}
			}
		}
		return null
	}

	const tryStartTrial = async (ctx: BotContext): Promise<boolean> => {
		const started = await subscriptionService.startTrialIfEligible(ctx.state.user.id)
		return started.started
	}

	const accountCreateErrorText = (error: unknown): string => {
		const message = error instanceof Error ? error.message.trim() : ''
		if (!message) return 'Не удалось сохранить счёт. Проверьте название, валюту и сумму.'
		return `Не удалось сохранить счёт: ${message}`
	}

	bot.callbackQuery('confirm_1_accounts', async ctx => {
		await answerCallbackBestEffort(ctx)
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

			try {
				const unsupportedCurrency = await validateDraftCurrencies([draft as any])
				if (unsupportedCurrency) {
					await ctx.reply(
						`Не удалось сохранить счёт: валюта ${unsupportedCurrency} не поддерживается. Укажите ISO-код (например: EUR, USD, UAH, TON).`,
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					return
				}
				const limitAccount = await subscriptionService.canCreateAccount(ctx.state.user.id)
			if (!limitAccount.allowed) {
				await subscriptionService.trackEvent(
					ctx.state.user.id,
					PremiumEventType.limit_hit,
					'accounts'
				)
				await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS }).catch(() => {})
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
				await subscriptionService.trackEvent(
					ctx.state.user.id,
					PremiumEventType.limit_hit,
					'assets'
				)
				await ctx.answerCallbackQuery({ text: UPSELL_ASSETS }).catch(() => {})
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
			} catch (error: unknown) {
				await ctx.reply(accountCreateErrorText(error), {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				return
			}

			drafts.splice(index, 1)
			if (drafts.length) {
				ctx.session.currentAccountIndex =
					index >= drafts.length ? drafts.length - 1 : index
				await refreshAccountsPreview(ctx)
				return
			}

			ctx.session.draftAccounts = undefined
			ctx.session.currentAccountIndex = undefined
			ctx.session.confirmingAccounts = false
			ctx.session.awaitingAccountInput = false
			await closePreviewMessage(ctx)
			await closeAccountInputHints(ctx)

				await ctx.reply(`✅ Счёт сохранён: ${draft.name}`, {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				const trialStarted = await tryStartTrial(ctx)
				await cleanupOnboardingMessagesAfterTwoAccounts(ctx)
				await refreshStartPanel(ctx)
				if (trialStarted) {
					await ctx.reply(TRIAL_DAY1_TEXT, {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
				}
			} finally {
			sessionAny.savingAccountLocks = (sessionAny.savingAccountLocks ?? []).filter(
				(k: string) => k !== lockKey
			)
		}
	})

	bot.callbackQuery('cancel_1_accounts', async ctx => {
		await answerCallbackBestEffort(ctx)
		const drafts = ctx.session.draftAccounts
		const index = ctx.session.currentAccountIndex ?? 0
		if (!drafts || !drafts.length) return

		drafts.splice(index, 1)
		if (drafts.length) {
			ctx.session.currentAccountIndex =
				index >= drafts.length ? drafts.length - 1 : index
			await refreshAccountsPreview(ctx)
			return
		}

		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false
		await closePreviewMessage(ctx)
		await closeAccountInputHints(ctx)
	})

	bot.callbackQuery('confirm_all_accounts', async ctx => {
		await answerCallbackBestEffort(ctx)
		const drafts = ctx.session.draftAccounts
		if (!drafts || !drafts.length) return
		const sessionAny = ctx.session as any
		if (sessionAny.savingAllAccounts) return
		sessionAny.savingAllAccounts = true

			try {
				const unsupportedCurrency = await validateDraftCurrencies(drafts as any)
				if (unsupportedCurrency) {
					await ctx.reply(
						`Не удалось сохранить счета: валюта ${unsupportedCurrency} не поддерживается. Укажите ISO-код (например: EUR, USD, UAH, TON).`,
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					return
				}
				const limitAccount = await subscriptionService.canCreateAccount(ctx.state.user.id)
			if (!limitAccount.allowed) {
				await subscriptionService.trackEvent(
					ctx.state.user.id,
					PremiumEventType.limit_hit,
					'accounts'
				)
				await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS }).catch(() => {})
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
				await subscriptionService.trackEvent(
					ctx.state.user.id,
					PremiumEventType.limit_hit,
					'accounts'
				)
				await ctx.answerCallbackQuery({ text: UPSELL_ACCOUNTS }).catch(() => {})
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
				await subscriptionService.trackEvent(
					ctx.state.user.id,
					PremiumEventType.limit_hit,
					'assets'
				)
				await ctx.answerCallbackQuery({ text: UPSELL_ASSETS }).catch(() => {})
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
			let firstError: string | null = null
			const createdNames: string[] = []
			for (const draft of drafts) {
				try {
					await accountsService.createAccountWithAssets(ctx.state.user.id, draft)
					created++
					if (draft?.name) createdNames.push(draft.name)
				} catch (error: unknown) {
					firstError = firstError ?? accountCreateErrorText(error)
				}
			}

			ctx.session.currentAccountIndex = undefined
			ctx.session.confirmingAccounts = false
			ctx.session.awaitingAccountInput = false
			await closePreviewMessage(ctx)
			await closeAccountInputHints(ctx)

			await ctx.reply(
				created > 0
					? `✅ Счета сохранены: ${createdNames.join(', ')}`
					: firstError ?? 'Не удалось сохранить счета.',
				{
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				}
			)

				const trialStarted = created > 0 ? await tryStartTrial(ctx) : false
				if (created > 0) {
					await refreshStartPanel(ctx)
				} else {
					await refreshAccountsPanel(ctx)
				}
				if (created > 0) {
					await cleanupOnboardingMessagesAfterTwoAccounts(ctx)
				}
				if (trialStarted) {
					await ctx.reply(TRIAL_DAY1_TEXT, {
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					})
				}
			} finally {
			sessionAny.savingAllAccounts = false
		}
	})

	bot.callbackQuery('cancel_all_accounts', async ctx => {
		await answerCallbackBestEffort(ctx)
		ctx.session.draftAccounts = undefined
		ctx.session.currentAccountIndex = undefined
		ctx.session.confirmingAccounts = false
		await closePreviewMessage(ctx)
		await closeAccountInputHints(ctx)
	})
}
