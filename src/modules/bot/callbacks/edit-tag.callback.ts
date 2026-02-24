import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TagsService } from '../../../modules/tags/tags.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { TransactionsService } from '../../../modules/transactions/transactions.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { persistPreviewTransactionIfNeeded } from '../utils/persist-preview-transaction'

const TAG_PAGE_SIZE = 9

const TAG_NONE = 'none'

function buildTagsKeyboard(
	tags: { id: string; name: string }[],
	page: number,
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
	const start = page * TAG_PAGE_SIZE
	const slice = tags.slice(start, start + TAG_PAGE_SIZE)
	for (let i = 0; i < slice.length; i += 3) {
		const chunk = slice.slice(i, i + 3)
		rows.push(
			chunk.map(t => ({
				text: t.id === currentTagId ? `✅ ${t.name}` : t.name,
				callback_data: `set_tag:${t.id}`
			}))
		)
	}

	const totalPages = Math.max(1, Math.ceil((tags.length || 1) / TAG_PAGE_SIZE))
	if (totalPages > 1) {
		rows.push([
			{ text: '« Назад', callback_data: 'tags_page:prev' },
			{ text: `${page + 1}/${totalPages}`, callback_data: 'tags_page:noop' },
			{ text: 'Вперёд »', callback_data: 'tags_page:next' }
		])
	}
	rows.push([{ text: '➕ Создать новый тег', callback_data: 'create_tag_from_preview' }])
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
		const tags = await tagsService.getAllByUserId(userId)
		ctx.session.editingField = 'tag'
		ctx.session.tagsPage = 0
		ctx.session.awaitingTransaction = false
		ctx.session.awaitingAccountInput = false
		ctx.session.awaitingTagsJarvisEdit = false
		ctx.session.awaitingCategoryName = false
		ctx.session.editingTimezone = false
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingCurrency = false
		ctx.session.awaitingTagInput = true

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		const currentTagId = current?.tagId ?? null

		const kb = buildTagsKeyboard(
			tags.map(t => ({ id: t.id, name: t.name })),
			0,
			currentTagId
		)

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.tempMessageId,
					'Выберите тег или отправьте название нового тега (до 20 символов):',
					{ reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery('create_tag_from_preview', async ctx => {
		ctx.session.awaitingTransaction = false
		ctx.session.awaitingAccountInput = false
		ctx.session.awaitingTagsJarvisEdit = false
		ctx.session.awaitingCategoryName = false
		ctx.session.editingTimezone = false
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingCurrency = false
		ctx.session.awaitingTagInput = true
		const hint = await ctx.reply('Введите название нового тега (до 20 символов):', {
			reply_markup: {
				inline_keyboard: [[{ text: 'Закрыть', callback_data: 'hide_message' }]]
			}
		})
		;(ctx.session as any).tagInputHintMessageId = hint.message_id
	})

	bot.callbackQuery(/^tags_page:/, async ctx => {
		if (ctx.session.tempMessageId == null) return

		const userId = ctx.state.user.id
		const tags = await tagsService.getAllByUserId(userId)
		const totalPages = Math.max(1, Math.ceil(tags.length / TAG_PAGE_SIZE))
		let page = ctx.session.tagsPage ?? 0

		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1

		ctx.session.tagsPage = page

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any
		const currentTagId = current?.tagId ?? null

		const kb = buildTagsKeyboard(
			tags.map(t => ({ id: t.id, name: t.name })),
			page,
			currentTagId
		)

		try {
			await ctx.api.editMessageReplyMarkup(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				{
					reply_markup: kb
				}
			)
		} catch {}
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
					renderConfirmMessage(
						current,
						index,
						drafts.length,
						user.defaultAccountId
					),
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
			return
		}
		const tag = await tagsService.findById(tagId, ctx.state.user.id)
		if (!tag) return

		current.tagId = tag.id
		current.tagName = tag.name
		current.tagIsNew = false
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
				renderConfirmMessage(
					current,
					index,
					drafts.length,
					user.defaultAccountId
				),
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
	})
}
