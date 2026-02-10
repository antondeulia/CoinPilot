import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TagsService } from '../../../modules/tags/tags.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { renderHome } from '../utils/render-home'

export async function getShowConversion(
	draft: any,
	accountId: string | null,
	userId: string,
	accountsService: AccountsService
): Promise<boolean> {
	if (!accountId || !draft?.currency) return true
	const account = await accountsService.getOneWithAssets(accountId, userId)
	if (!account) return true
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
	subscriptionService: SubscriptionService
) => {
	bot.callbackQuery('confirm_tx', async ctx => {
		const drafts = ctx.session.draftTransactions
		const user: any = ctx.state.user

		if (!drafts || drafts.length === 0) {
			ctx.session.awaitingTransaction = true
			return
		}

		// Лимит транзакций для Free
		const newCount = drafts.length
		const txLimit = await subscriptionService.canCreateTransaction(user.id)
		if (!txLimit.allowed || txLimit.current + newCount > txLimit.limit) {
			await ctx.answerCallbackQuery({
				text: '👑 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!'
			})
			await ctx.reply(
				'👑 30 транзакций в месяц — лимит Free. Разблокируйте безлимит с Premium!',
				{
					reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
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
				limit.current + newTagCount > limit.limit
			) {
				await ctx.answerCallbackQuery({
					text: '👑 10 кастомных тегов — лимит Free. Разблокируйте безлимит с Premium!'
				})
				await ctx.reply(
					'👑 10 кастомных тегов использовано. Разблокируйте безлимит с Premium!',
					{
						reply_markup: new InlineKeyboard().text('👑 Premium', 'view_premium')
					}
				)
				return
			}
		}

		for (const draft of drafts as any[]) {
			const accountId =
				draft.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
			if (!accountId) continue

			let tagId = draft.tagId
			if (draft.tagIsNew && draft.tagName) {
				const tag = await tagsService.create(ctx.state.user.id, draft.tagName)
				tagId = tag.id
			}
			if (tagId) {
				await tagsService.incrementUsage(tagId)
			}

			const isTransfer = draft.direction === 'transfer'
			await transactionsService.create({
				accountId,
				amount: draft.amount!,
				currency: draft.currency!,
				direction: draft.direction,
				...(isTransfer
					? {
							fromAccountId: accountId,
							toAccountId: draft.toAccountId ?? undefined
						}
					: { category: draft.category ?? 'Не выбрано' }),
				description: draft.description,
				rawText: draft.rawText || '',
				userId: ctx.state.user.id,
				tagId: tagId ?? undefined,
				convertedAmount: draft.convertedAmount,
				convertToCurrency: draft.convertToCurrency,
				transactionDate: draft.transactionDate
					? new Date(draft.transactionDate)
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
		await renderHome(ctx as any, accountsService)
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
	if (isTransfer) {
		kb.text('На счёт', 'edit:target_account')
	}
	kb.text('Дата', 'edit:date')
	if (!isTransfer) {
		kb.text('Категория', 'edit:category')
	}
	kb.row().text('Валюта', 'edit:currency')

	if (showConversion) {
		kb.text('Конвертация', 'edit:conversion')
	}
	kb.text('Теги', 'edit:tag')

	if (!isEditingExisting && total > 1) {
		kb.row()
			.text('Сохранить 1', 'confirm_1_transactions')
			.text('Удалить 1', 'cancel_1_transactions')
	}
	if (hasPagination) {
		kb.row()
			.text('« Назад', 'pagination_back_transactions')
			.text(`${currentIndex + 1}/${total}`, 'pagination_preview_transactions')
			.text('Вперёд »', 'pagination_forward_transactions')
	}
	if (isEditingExisting) {
		kb.row()
			.text('Сохранить изменения', 'save_edit_transaction')
			.text('Удалить транзакцию', 'delete_transaction')
		kb.row().text('← Назад к списку', 'back_to_transactions')
	} else {
		kb.row().text('Сохранить все', 'confirm_tx').text('Удалить все', 'cancel_tx')
		kb.row().text('Повторить', 'repeat_parse')
	}
	return kb
}
