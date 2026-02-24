import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TagsService } from '../../../modules/tags/tags.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { renderHome } from '../utils/render-home'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard } from './confirm-tx'
import { normalizeTxDate } from '../../../utils/date'

async function refreshPreview(ctx: BotContext, accountsService: AccountsService) {
	const drafts = ctx.session.draftTransactions
	const index = ctx.session.currentTransactionIndex ?? 0

	if (!drafts || !drafts.length || ctx.session.tempMessageId == null) return

	const current = drafts[index] as any
	const user = ctx.state.user as any
	const accountId =
		current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
	let showConversion = false
	if (accountId) {
		const account = await accountsService.getOneWithAssets(
			accountId,
			ctx.state.user.id
		)
		if (account) {
			const codes = Array.from(
				new Set(account.assets?.map(a => a.currency || account.currency) ?? [])
			)
			showConversion = !codes.includes(current.currency)
		}
	}

	try {
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.tempMessageId,
			renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
			{
				parse_mode: 'HTML',
				reply_markup: confirmKeyboard(
					drafts.length,
					index,
					showConversion,
					current?.direction === 'transfer' && !current?.tradeType,
					!!ctx.session.editingTransactionId,
					current?.tradeType
				)
			}
		)
	} catch {}
}

export const saveDeleteCallback = (
	bot: Bot<BotContext>,
	transactionsService: TransactionsService,
	accountsService: AccountsService,
	tagsService: TagsService,
	subscriptionService: SubscriptionService,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('ask_cancel_1_transactions', async ctx => {
		if (ctx.session.tempMessageId == null) return
		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				'Удалить текущую операцию из предпросмотра?',
				{
					reply_markup: new InlineKeyboard()
						.text('Да', 'cancel_1_transactions_confirm_yes')
						.text('Нет', 'cancel_1_transactions_confirm_no')
				}
			)
		} catch {}
	})

	bot.callbackQuery('cancel_1_transactions_confirm_no', async ctx => {
		await refreshPreview(ctx, accountsService)
	})

	bot.callbackQuery('cancel_1_transactions_confirm_yes', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0

		if (!drafts || !drafts.length) return
		const current = drafts[index] as any
		if (current?.id) {
			await transactionsService.delete(current.id, ctx.state.user.id)
		}
		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftTransactions = undefined
			ctx.session.currentTransactionIndex = undefined
			ctx.session.confirmingTransaction = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}
			return
		}

		ctx.session.currentTransactionIndex =
			index >= drafts.length ? drafts.length - 1 : index
		await refreshPreview(ctx, accountsService)
	})

	bot.callbackQuery('confirm_1_transactions', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0

		if (!drafts || !drafts.length) return

		const draft = drafts[index] as any
		if (draft?.id) {
			drafts.splice(index, 1)
			if (!drafts.length) {
				ctx.session.draftTransactions = undefined
				ctx.session.currentTransactionIndex = undefined
				ctx.session.confirmingTransaction = false
				if (ctx.session.tempMessageId != null) {
					try {
						await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
					} catch {}
					ctx.session.tempMessageId = undefined
				}
				return
			}
			ctx.session.currentTransactionIndex =
				index >= drafts.length ? drafts.length - 1 : index
			await refreshPreview(ctx, accountsService)
			return
		}
		// Лимит транзакций для Free
		const limit = await subscriptionService.canCreateTransaction(ctx.state.user.id)
		if (!limit.allowed) {
			await ctx.answerCallbackQuery({
				text: '💠 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!'
			})
			await ctx.reply(
				'💠 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}

		let tagId = draft.tagId
		if (draft.tagIsNew && draft.tagName) {
			const limit = await subscriptionService.canCreateTag(ctx.state.user.id)
			if (
				!limit.allowed ||
				(!ctx.state.isPremium && limit.current + 1 > limit.limit)
			) {
				await ctx.answerCallbackQuery({
					text: ctx.state.isPremium
						? 'Достигнут системный лимит тегов.'
						: '💠 3 кастомных тега — лимит Free. Разблокируйте безлимит с Premium!'
				})
				await ctx.reply(
					ctx.state.isPremium
						? 'Достигнут системный лимит тегов. Удалите лишние теги и попробуйте снова.'
						: '💠 3 кастомных тега — лимит Free. Разблокируйте безлимит с Premium!',
					ctx.state.isPremium
						? {
								reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
							}
						: {
								reply_markup: new InlineKeyboard()
									.text('💠 Pro-тариф', 'view_premium')
									.row()
									.text('Закрыть', 'hide_message')
							}
				)
				return
			}
			const tag = await tagsService.create(ctx.state.user.id, draft.tagName)
			tagId = tag.id
		}
		if (tagId) await tagsService.incrementUsage(tagId)

		const isTransfer = draft.direction === 'transfer'
		const allAccounts = await accountsService.getAllByUserIdIncludingHidden(
			ctx.state.user.id
		)
		const outsideWalletId =
			allAccounts.find(a => a.name === 'Вне Wallet')?.id ?? null
		const visibleAccounts = allAccounts.filter(
			a => !a.isHidden && a.name !== 'Вне Wallet'
		)
		const fallbackVisibleAccountId =
			visibleAccounts.find(a => a.id === (ctx.state.user as any).defaultAccountId)?.id ??
			visibleAccounts[0]?.id ??
			null
		const sourceAccountId = draft.accountId || fallbackVisibleAccountId
		if (!sourceAccountId) {
			await ctx.reply('Сначала добавьте счёт во вкладке «Счета», затем создайте транзакцию.', {
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			})
			return
		}
		if (!isTransfer && sourceAccountId === outsideWalletId) {
			await ctx.reply('Счёт «Вне Wallet» нельзя использовать для доходов и расходов.', {
				reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
			})
			return
		}
		await transactionsService.create({
			accountId: sourceAccountId,
			amount: draft.amount!,
			currency: draft.currency!,
			direction: draft.direction,
			tradeType: draft.tradeType ?? undefined,
			tradeBaseCurrency: draft.tradeBaseCurrency ?? undefined,
			tradeBaseAmount: draft.tradeBaseAmount ?? undefined,
			tradeQuoteCurrency: draft.tradeQuoteCurrency ?? undefined,
			tradeQuoteAmount: draft.tradeQuoteAmount ?? undefined,
			executionPrice: draft.executionPrice ?? undefined,
			tradeFeeCurrency: draft.tradeFeeCurrency ?? undefined,
			tradeFeeAmount: draft.tradeFeeAmount ?? undefined,
			...(isTransfer
				? {
						fromAccountId: sourceAccountId,
						toAccountId:
							draft.toAccountId ??
							(draft.tradeType
								? sourceAccountId
								: outsideWalletId ?? undefined)
					}
				: {
						categoryId: draft.categoryId ?? undefined,
						category: draft.category ?? '📦Другое'
					}),
			description: draft.description,
			rawText: draft.rawText || '',
			userId: ctx.state.user.id,
			transactionDate: draft.transactionDate
				? (normalizeTxDate(draft.transactionDate) ?? undefined)
				: undefined,
			fromAccountId: isTransfer
				? sourceAccountId
				: draft.fromAccountId,
			toAccountId: isTransfer
				? draft.toAccountId ??
					(draft.tradeType
						? sourceAccountId
						: outsideWalletId ?? undefined)
				: draft.toAccountId,
			tagId: tagId ?? undefined,
			convertedAmount: draft.convertedAmount,
			convertToCurrency: draft.convertToCurrency
		})

		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftTransactions = undefined
			ctx.session.currentTransactionIndex = undefined
			ctx.session.confirmingTransaction = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}

			;(ctx.session as any).homeMessageId = undefined

			const msg = await ctx.reply(
				'✅ Транзакция успешно сохранена.\n\nВозвращаюсь на главный экран.',
				{
					parse_mode: 'HTML',
					reply_markup: {
						inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]]
					}
				}
			)
			ctx.session.tempMessageId = msg.message_id

			await renderHome(ctx as any, accountsService, analyticsService)

			return
		}

		ctx.session.currentTransactionIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshPreview(ctx, accountsService)
	})

	bot.callbackQuery('cancel_1_transactions', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0

		if (!drafts || !drafts.length) return
		const current = drafts[index] as any
		if (current?.id) {
			await transactionsService.delete(current.id, ctx.state.user.id)
		}

		drafts.splice(index, 1)

		if (!drafts.length) {
			ctx.session.draftTransactions = undefined
			ctx.session.currentTransactionIndex = undefined
			ctx.session.confirmingTransaction = false

			if (ctx.session.tempMessageId != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}

			return
		}

		ctx.session.currentTransactionIndex =
			index >= drafts.length ? drafts.length - 1 : index

		await refreshPreview(ctx, accountsService)
	})
}
