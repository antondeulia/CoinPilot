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
	if (!accountId || !draft?.currency) return false
	const account = await accountsService.getOneWithAssets(accountId, userId)
	if (!account) return false
	const codes = Array.from(
		new Set(
			account.assets?.map(a => String(a.currency || account.currency).toUpperCase()) ?? []
		)
	)
	return !codes.includes(String(draft.currency ?? '').toUpperCase())
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

		// Лимит транзакций для Basic
		const newCount = drafts.length
		const txLimit = await subscriptionService.canCreateTransaction(user.id)
		if (!txLimit.allowed || txLimit.current + newCount > txLimit.limit) {
			await ctx.answerCallbackQuery({
				text: '💠 30 транзакций в месяц — лимит Basic. Разблокируйте безлимит с тарифом Pro!'
			})
			await ctx.reply(
				'💠 30 транзакций в месяц — лимит Basic. Разблокируйте безлимит с тарифом Pro!',
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
						: '💠 3 кастомных тега — лимит Basic. Разблокируйте безлимит с Pro-тарифом!'
				})
				await ctx.reply(
					ctx.state.isPremium
						? 'Достигнут системный лимит тегов. Удалите лишние теги и попробуйте снова.'
						: '💠 3 кастомных тега использовано. Разблокируйте безлимит с Pro-тарифом!',
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

				for (const draft of drafts as any[]) {
					const accountId =
						draft.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
					if (!accountId) continue
					if (
						typeof draft.amount !== 'number' ||
						!Number.isFinite(draft.amount) ||
						draft.amount <= 0 ||
						!draft.currency
					) {
						await ctx.reply(
							'Транзакция не сохранена: не хватает критичных данных (сумма, валюта).',
							{
								reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
							}
						)
						return
					}
					if (
						draft.direction !== 'transfer' &&
						outsideWalletId &&
					accountId === outsideWalletId
				) {
					await ctx.reply(
						'Для доходов и расходов нельзя использовать счёт «Вне Wallet». Выберите обычный счёт.',
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
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

				const isTransfer = draft.direction === 'transfer'
				const toAccountId = draft.toAccountId ?? outsideWalletId ?? undefined
				if (
					isTransfer &&
					outsideWalletId &&
					accountId === outsideWalletId &&
					toAccountId === outsideWalletId
				) {
					await ctx.reply(
						'В переводе счёт «Вне Wallet» можно выбрать только в одном поле.',
						{
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						}
					)
					return
				}
				await transactionsService.create({
					accountId,
				amount: draft.amount!,
				currency: draft.currency!,
				direction: draft.direction,
						...(isTransfer
							? {
									fromAccountId: accountId,
									toAccountId
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

		// 🟢 success-сообщение
			const msg = await ctx.reply(successText, {
				parse_mode: 'HTML',
				reply_markup: successKeyboard
			})
			ctx.session.resultMessageIds = [
				...((ctx.session.resultMessageIds ?? []) as number[]),
				msg.message_id
			]

		// показать/обновить домашний экран как после /start
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
	isEditingExisting: boolean = false
): InlineKeyboard {
	const hasPagination = total > 1 && !isEditingExisting

	const kb = new InlineKeyboard()
		.text('Тип', 'edit:type')
		.text('Название', 'edit:description')
		.text('Сумма', 'edit:amount')
		.row()
		.text('Счёт', 'edit:account')
		.text('Дата', 'edit:date')
	if (isTransfer) kb.text('На счёт', 'edit:target_account')
	else kb.text('Категория', 'edit:category')
	kb.row().text('Валюта', 'edit:currency')

	if (showConversion) {
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
			.text('🔁 Повторить', 'repeat_tx_confirm_open')
		kb.row().text('Закрыть', 'close_preview')
	} else {
		kb.row()
			.text('🗑 Удалить', 'ask_cancel_tx')
			.text('🔁 Повторить', 'repeat_tx_confirm_open')
		kb.row().text('Закрыть', 'close_preview')
	}
	return kb
}
