import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TransactionsService } from 'src/modules/transactions/transactions.service'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { TagsService } from 'src/modules/tags/tags.service'
import { renderHome } from '../utils/render-home'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard } from './confirm-tx'

async function refreshPreview(ctx: BotContext, accountsService: AccountsService) {
	const drafts = ctx.session.draftTransactions
	const index = ctx.session.currentTransactionIndex ?? 0

	if (!drafts || !drafts.length || ctx.session.tempMessageId == null) return

	const current = drafts[index] as any
	const user = ctx.state.user as any
	const accountId =
		current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
	let showConversion = true
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
					current?.direction === 'transfer',
					!!ctx.session.editingTransactionId
				)
			}
		)
	} catch {}
}

export const saveDeleteCallback = (
	bot: Bot<BotContext>,
	transactionsService: TransactionsService,
	accountsService: AccountsService,
	tagsService: TagsService
) => {
	bot.callbackQuery('confirm_1_transactions', async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const account = ctx.state.activeAccount

		if (!drafts || !drafts.length || !account) return

		const draft = drafts[index] as any
		let tagId = draft.tagId
		if (draft.tagIsNew && draft.tagName) {
			const tag = await tagsService.create(ctx.state.user.id, draft.tagName)
			tagId = tag.id
		}
		if (tagId) await tagsService.incrementUsage(tagId)

		const isTransfer = draft.direction === 'transfer'
		await transactionsService.create({
			accountId: draft.accountId || account.id,
			amount: draft.amount!,
			currency: draft.currency!,
			direction: draft.direction,
			...(isTransfer
				? {
						fromAccountId: draft.accountId || account.id,
						toAccountId: draft.toAccountId ?? undefined
					}
				: { category: draft.category ?? 'Не выбрано' }),
			description: draft.description,
			rawText: draft.rawText || '',
			userId: ctx.state.user.id,
			transactionDate: draft.transactionDate
				? new Date(draft.transactionDate)
				: undefined,
			fromAccountId: isTransfer
				? draft.accountId || account.id
				: draft.fromAccountId,
			toAccountId: draft.toAccountId,
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
					parse_mode: 'HTML'
				}
			)
			ctx.session.tempMessageId = msg.message_id

			await renderHome(ctx as any, accountsService)

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
