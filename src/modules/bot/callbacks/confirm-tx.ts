import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TagsService } from '../../../modules/tags/tags.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { renderHome } from '../utils/render-home'
import { normalizeTxDate } from '../../../utils/date'

export async function getShowConversion(
	draft: any,
	accountId: string | null,
	userId: string,
	accountsService: AccountsService
): Promise<boolean> {
	if (draft?.tradeType === 'buy' || draft?.tradeType === 'sell') return false
	if (!accountId || !draft?.currency) return false
	const account = await accountsService.getOneWithAssets(accountId, userId)
	if (!account) return false
	const codes = Array.from(
		new Set(account.assets?.map(a => a.currency || account.currency) ?? [])
	)
	return !codes.includes(draft.currency)
}

export const confirmTxCallback = (
	bot: Bot<BotContext>,
	transactionsService: TransactionsService,
	accountsService: AccountsService,
	tagsService: TagsService,
	subscriptionService: SubscriptionService,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('confirm_tx', async ctx => {
		const drafts = ctx.session.draftTransactions
		const user: any = ctx.state.user

		if (!drafts || drafts.length === 0) {
			ctx.session.awaitingTransaction = true
			return
		}
		if ((drafts as any[]).every((d: any) => !!d.id)) {
			ctx.session.confirmingTransaction = false
			ctx.session.draftTransactions = undefined
			ctx.session.currentTransactionIndex = undefined
			ctx.session.editingField = undefined
			if (ctx.session.tempMessageId) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
				ctx.session.tempMessageId = undefined
			}
			return
		}

		// Лимит транзакций для Free
		const newCount = drafts.length
		const txLimit = await subscriptionService.canCreateTransaction(user.id)
		if (!txLimit.allowed || txLimit.current + newCount > txLimit.limit) {
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

		const newTagCount = (drafts as any[]).filter(
			(d: any) => d.tagIsNew && d.tagName
		).length
		if (newTagCount > 0) {
			const limit = await subscriptionService.canCreateTag(ctx.state.user.id)
			if (
				!limit.allowed ||
				(!ctx.state.isPremium && limit.current + newTagCount > limit.limit)
			) {
				await ctx.answerCallbackQuery({
					text: ctx.state.isPremium
						? 'Достигнут системный лимит тегов.'
						: '💠 3 кастомных тега — лимит Free. Разблокируйте безлимит с Premium!'
				})
				await ctx.reply(
					ctx.state.isPremium
						? 'Достигнут системный лимит тегов. Удалите лишние теги и попробуйте снова.'
						: '💠 3 кастомных тега использовано. Разблокируйте безлимит с Premium!',
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
		}

		const allAccounts = await accountsService.getAllByUserIdIncludingHidden(user.id)
		const outsideWalletId =
			allAccounts.find(a => a.name === 'Вне Wallet')?.id ?? null
		const visibleAccounts = allAccounts.filter(
			a => !a.isHidden && a.name !== 'Вне Wallet'
		)
		const fallbackVisibleAccountId =
			visibleAccounts.find(a => a.id === user.defaultAccountId)?.id ??
			visibleAccounts[0]?.id ??
			null

		for (const draft of drafts as any[]) {
			const isTransfer = draft.direction === 'transfer'
			const accountId =
				draft.accountId ||
				fallbackVisibleAccountId ||
				ctx.state.activeAccount?.id
			if (!accountId) continue
			if (!isTransfer && accountId === outsideWalletId) {
				await ctx.reply('Счёт «Вне Wallet» нельзя использовать для доходов и расходов.', {
					reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
				})
				return
			}

			let tagId = draft.tagId
			if (draft.tagIsNew && draft.tagName) {
				const tag = await tagsService.create(ctx.state.user.id, draft.tagName)
				tagId = tag.id
			}
			if (tagId) {
				await tagsService.incrementUsage(tagId)
			}

			await transactionsService.create({
				accountId,
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
							fromAccountId: accountId,
							toAccountId:
								draft.toAccountId ??
								(draft.tradeType ? accountId : outsideWalletId ?? undefined)
						}
					: {
							categoryId: draft.categoryId ?? undefined,
							category: draft.category ?? '📦Другое'
						}),
				description: draft.description,
				rawText: draft.rawText || '',
				userId: ctx.state.user.id,
				tagId: tagId ?? undefined,
				convertedAmount: draft.convertedAmount,
				convertToCurrency: draft.convertToCurrency,
				transactionDate: draft.transactionDate
					? (normalizeTxDate(draft.transactionDate) ?? undefined)
					: undefined
			})
		}

		// 🧹 чистим confirm-состояние
		ctx.session.confirmingTransaction = false
		ctx.session.draftTransactions = undefined
		ctx.session.currentTransactionIndex = undefined
		ctx.session.editingField = undefined

		ctx.session.awaitingTransaction = false

		// удаляем confirm-сообщение
		if (ctx.session.tempMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
			} catch {}
			ctx.session.tempMessageId = undefined
		}
		if (ctx.session.editMessageId) {
			try {
				await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.editMessageId)
			} catch {}
			ctx.session.editMessageId = undefined
		}

		;(ctx.session as any).homeMessageId = undefined

		// 🟢 success-сообщение
		const msg = await ctx.reply(successText, {
			parse_mode: 'HTML',
			reply_markup: successKeyboard
		})

		ctx.session.tempMessageId = msg.message_id

		// показать домашний экран как после /start (новым сообщением)
		await renderHome(ctx as any, accountsService, analyticsService)
	})
}

const successKeyboard = {
	inline_keyboard: [[{ text: '🙈 Закрыть', callback_data: 'hide_message' }]]
}

const successText = `
✅ <b>Транзакция успешно создана!</b>

Можешь добавить ещё одну — просто напиши сообщение.
`

export function confirmKeyboard(
	total: number,
	currentIndex: number,
	showConversion: boolean = true,
	isTransfer: boolean = false,
	isEditingExisting: boolean = false,
	tradeType?: 'buy' | 'sell'
): InlineKeyboard {
	const isTrade = tradeType === 'buy' || tradeType === 'sell'
	const hasPagination = total > 1 && !isEditingExisting

	const kb = new InlineKeyboard()
		.text('Тип', 'edit:type')
		.text('Название', 'edit:description')
		.text('Сумма', 'edit:amount')
	if (isTrade) {
		kb.row().text('Счёт', 'edit:account').text('Комиссия', 'edit:fee').text('Дата', 'edit:date')
	} else {
		kb.row().text('Счёт', 'edit:account').text('Дата', 'edit:date')
		if (isTransfer) kb.text('На счёт', 'edit:target_account')
		else kb.text('Категория', 'edit:category')
	}
	kb.row().text(isTrade ? 'Пара' : 'Валюта', isTrade ? 'edit:pair' : 'edit:currency')

	if (isTrade) {
		kb.text('Ср. цена', 'edit:execution_price')
	} else if (showConversion) {
		kb.text('Конвертация', 'edit:conversion')
	}
	kb.text('Теги', 'edit:tag')

	if (!isEditingExisting && total > 1) {
		kb.row().text('🗑 Удалить', 'ask_cancel_1_transactions')
	}
	if (hasPagination) {
		kb.row()
			.text('« Назад', 'pagination_back_transactions')
			.text(`${currentIndex + 1}/${total}`, 'pagination_preview_transactions')
			.text('Вперёд »', 'pagination_forward_transactions')
	}
	if (isEditingExisting) {
		kb.row().text('Удалить транзакцию', 'delete_transaction')
		kb.row().text('← Назад к списку', 'back_to_transactions')
	} else if (total > 1) {
		kb.row()
			.text('🗑 Удалить всё', 'ask_cancel_tx')
			.text('🔁 Повторить', 'repeat_parse')
		kb.row().text('Закрыть', 'close_preview')
	} else {
		kb.row().text('🗑 Удалить', 'ask_cancel_tx').text('🔁 Повторить', 'repeat_parse')
		kb.row().text('Закрыть', 'close_preview')
	}
	return kb
}
