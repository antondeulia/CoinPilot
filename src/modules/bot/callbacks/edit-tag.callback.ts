import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TagsService } from '../../../modules/tags/tags.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { persistPreviewTransactionIfNeeded } from '../utils/persist-preview-transaction'

const TAG_NONE = 'none'
const TAGS_PREVIEW_LIMIT = 9

function buildTagsKeyboard(
	tags: { id: string; name: string }[],
	currentTagId?: string | null
) {
	const rows: { text: string; callback_data: string }[][] = []
	rows.push([
		{
			text:
				currentTagId == null || currentTagId === ''
					? '✅ Не выбрано'
					: 'Не выбрано',
			callback_data: `set_tag:${TAG_NONE}`
		}
	])

	const limited = tags.slice(0, TAGS_PREVIEW_LIMIT)
	for (let i = 0; i < limited.length; i += 3) {
		const chunk = limited.slice(i, i + 3)
		rows.push(
			chunk.map(t => ({
				text: t.id === currentTagId ? `✅ ${t.name}` : t.name,
				callback_data: `set_tag:${t.id}`
			}))
		)
	}
	rows.push([{ text: '← Назад', callback_data: 'back_to_preview' }])
	return { inline_keyboard: rows }
}

export const editTagCallback = (
	bot: Bot<BotContext>,
	tagsService: TagsService,
	accountsService: AccountsService,
	transactionsService: TransactionsService
) => {
	bot.callbackQuery('edit:tag', async ctx => {
		const userId = ctx.state.user.id
		const tags = await tagsService.getPopular(userId, TAGS_PREVIEW_LIMIT)
		ctx.session.editingField = 'tag'
		ctx.session.awaitingTagInput = true
		ctx.session.newTagNamesInSession = []

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		const currentTagId = current?.tagId ?? null

		const kb = buildTagsKeyboard(
			tags.map(t => ({ id: t.id, name: t.name })),
			currentTagId
		)

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.tempMessageId,
					'Выберите тег или отправьте название тега текстом:',
					{ reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^set_tag:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		if (!drafts || !current || ctx.session.tempMessageId == null) return

		const tagId = ctx.callbackQuery.data.split(':')[1]
		if (tagId === TAG_NONE) {
			current.tagId = undefined
			current.tagName = undefined
			current.tagIsNew = false
			current.tagWasNewInSession = false
		} else {
			const tag = await tagsService.findById(tagId, ctx.state.user.id)
			if (!tag) return
			current.tagId = tag.id
			current.tagName = tag.name
			current.tagIsNew = false
			current.tagWasNewInSession = false
		}
		ctx.session.awaitingTagInput = false

		const user = ctx.state.user as any
		const accountId =
			current.accountId || user.defaultAccountId || ctx.state.activeAccount?.id
		const showConversion = await getShowConversion(
			current,
			accountId ?? null,
			ctx.state.user.id,
			accountsService
		)
		await persistPreviewTransactionIfNeeded(ctx, current, transactionsService)

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
	})

	// Backward compatibility for old messages with removed pagination/add button.
	bot.callbackQuery(/^tags_page:/, async ctx => {
		await ctx.answerCallbackQuery().catch(() => {})
	})
	bot.callbackQuery('create_tag_from_preview', async ctx => {
		await ctx.answerCallbackQuery().catch(() => {})
	})
}
