import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { CategoriesService } from '../../../modules/categories/categories.service'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { renderConfirmMessage } from '../elements/tx-confirm-msg'
import { confirmKeyboard, getShowConversion } from './confirm-tx'
import { activateInputMode } from '../core/input-mode'

const CATEGORY_PAGE_SIZE = 9

function buildCategoriesKeyboard(
	categories: { id: string; name: string }[],
	page: number,
	currentName?: string | null
) {
	const start = page * CATEGORY_PAGE_SIZE
	const slice = categories.slice(start, start + CATEGORY_PAGE_SIZE)
	const rows: any[] = []

	for (let i = 0; i < slice.length; i += 3) {
		const chunk = slice.slice(i, i + 3)
		rows.push(
			chunk.map(c => ({
				text: c.name === currentName ? `✅ ${c.name}` : c.name,
				callback_data: `set_category:${c.id}`
			}))
		)
	}

	const totalPages = Math.max(1, Math.ceil(categories.length / CATEGORY_PAGE_SIZE))
	if (totalPages > 1) {
		rows.push([
			{ text: '« Назад', callback_data: 'categories_page:prev' },
			{
				text: `${page + 1}/${totalPages}`,
				callback_data: 'categories_page:noop'
			},
			{ text: 'Вперёд »', callback_data: 'categories_page:next' }
		])
	}
	rows.push([{ text: 'Создать категорию', callback_data: 'create_category_from_preview' }])
	rows.push([{ text: '← Назад', callback_data: 'back_to_preview' }])

	return { inline_keyboard: rows }
}

export const editCategoryCallback = (
	bot: Bot<BotContext>,
	categoriesService: CategoriesService,
	accountsService: AccountsService
) => {
	bot.callbackQuery('edit:category', async ctx => {
		const userId = ctx.state.user.id
		const categories = await categoriesService.getSelectableByUserId(userId)
		ctx.session.categoriesPage = 0

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index]
		const currentName =
			current?.category && current.category !== '📦Другое'
				? current.category
				: null

		const kb = buildCategoriesKeyboard(
			categories.map(c => ({ id: c.id, name: c.name })),
			0,
			currentName
		)

		if (ctx.session.tempMessageId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					ctx.session.tempMessageId,
					'Выберите категорию:',
					{ reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^categories_page:/, async ctx => {
		if (ctx.session.tempMessageId == null) return

		const userId = ctx.state.user.id
		const categories = await categoriesService.getSelectableByUserId(userId)
		const totalPages = Math.max(1, Math.ceil(categories.length / CATEGORY_PAGE_SIZE))
		let page = ctx.session.categoriesPage ?? 0

		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1

		ctx.session.categoriesPage = page

		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index]
		const currentName =
			current?.category && current.category !== '📦Другое'
				? current.category
				: null

		const kb = buildCategoriesKeyboard(
			categories.map(c => ({ id: c.id, name: c.name })),
			page,
			currentName
		)

		try {
			await ctx.api.editMessageReplyMarkup(
				ctx.chat!.id,
				ctx.session.tempMessageId!,
				{
					reply_markup: kb
				}
			)
		} catch {}
	})

	bot.callbackQuery(/^set_category:/, async ctx => {
		const drafts = ctx.session.draftTransactions
		const index = ctx.session.currentTransactionIndex ?? 0
		const current = drafts?.[index]

		if (!drafts || !current || ctx.session.tempMessageId == null) {
			return
		}

		const categoryId = ctx.callbackQuery.data.split(':')[1]
		const category = await categoriesService.findById(categoryId, ctx.state.user.id)
		if (!category) return

			if (current.category === category.name) {
				current.category = '📦Другое'
				current.categoryId = undefined
			} else {
				current.category = category.name
				current.categoryId = category.id
			}

		const user = ctx.state.user as any
		const accountId =
			(current as any).accountId ||
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
						current?.direction === 'transfer',
						!!ctx.session.editingTransactionId
					)
				}
			)
		} catch {}
	})

	bot.callbackQuery('create_category_from_preview', async ctx => {
		activateInputMode(ctx, 'category_create', {
			awaitingInlineCategoryCreate: true,
			awaitingInlineTagCreate: false
		})
		const hint = await ctx.reply(
			'Введите название новой категории (до 20 символов).'
		)
		ctx.session.inlineCreateHintMessageId = hint.message_id
	})
}
