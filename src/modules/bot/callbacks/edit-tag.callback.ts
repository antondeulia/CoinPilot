import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TagsService } from 'src/modules/tags/tags.service'
import { AccountsService } from 'src/modules/accounts/accounts.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'

const TAG_PAGE_SIZE = 9

function buildTagsKeyboard(
	tags: { id: string; name: string }[],
	page: number,
	currentTagId?: string | null
) {
	const start = page * TAG_PAGE_SIZE
	const slice = tags.slice(start, start + TAG_PAGE_SIZE)
	const rows: { text: string; callback_data: string }[][] = []

	for (let i = 0; i < slice.length; i += 3) {
		const chunk = slice.slice(i, i + 3)
		rows.push(
			chunk.map(t => ({
				text: t.id === currentTagId ? `✅ ${t.name}` : t.name,
				callback_data: `set_tag:${t.id}`
			}))
		)
	}

	const totalPages = Math.max(1, Math.ceil(tags.length / TAG_PAGE_SIZE))
	rows.push([
		{ text: '« Назад', callback_data: 'tags_page:prev' },
		{ text: `${page + 1}/${totalPages}`, callback_data: 'tags_page:noop' },
		{ text: 'Вперёд »', callback_data: 'tags_page:next' }
	])
	rows.push([{ text: '← Назад', callback_data: 'back_to_preview' }])

	return { inline_keyboard: rows }
}

export const editTagCallback = (
	bot: Bot<BotContext>,
	tagsService: TagsService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('edit:tag', async ctx => {
		const userId = ctx.state.user.id
		const tags = await tagsService.getAllByUserId(userId)
		ctx.session.editingField = 'tag'
		ctx.session.tagsPage = 0
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
					'Выберите тег или отправьте название нового тега (до 15 символов):',
					{ reply_markup: kb }
				)
			} catch {}
		}
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
			await ctx.api.editMessageReplyMarkup(ctx.chat!.id, ctx.session.tempMessageId, {
				reply_markup: kb
			})
		} catch {}
	})

	bot.callbackQuery(/^set_tag:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index] as any

		if (!drafts || !current || ctx.session.tempMessageId == null) return

		const tagId = ctx.callbackQuery.data.split(':')[1]
		const tag = await tagsService.findById(tagId, ctx.state.user.id)
		if (!tag) return

		current.tagId = tag.id
		current.tagName = tag.name
		current.tagIsNew = false
		ctx.session.awaitingTagInput = false

		const user = ctx.state.user as any
		const accountId =
			current.accountId ||
			user.defaultAccountId ||
			ctx.state.activeAccount?.id
		const showConversion = await getShowConversion(
			current,
			accountId ?? null,
			ctx.state.user.id,
			accountsService
		)

		try {
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.tempMessageId,
				renderConfirmMessage(current, index, drafts.length, user.defaultAccountId),
				{
					parse_mode: 'HTML',
					reply_markup: confirmKeyboard(drafts.length, index, showConversion, current?.direction === 'transfer')
				}
			)
		} catch {}
	})
}
