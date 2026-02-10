import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { CategoriesService } from '../../../modules/categories/categories.service'

const PAGE_SIZE = 9

function settingsKeyboard() {
	return new InlineKeyboard()
		.text('Основная валюта', 'main_currency_open')
		.row()
		.text('Основной счёт', 'default_account_open')
		.row()
		.text('Категории', 'view_categories')
		.row()
		.text('Теги', 'view_tags')
		.row()
		.text('🠐 Назад', 'go_home')
}

function settingsText(user: {
	mainCurrency?: string
	defaultAccountId?: string
	accounts: { id: string; name: string }[]
}) {
	const mainCode = user?.mainCurrency ?? 'USD'
	const defaultAccount =
		user.accounts.find((a: any) => a.id === user.defaultAccountId) ?? user.accounts[0]
	const defaultAccountName = defaultAccount ? defaultAccount.name : '—'
	return `<b>⚙️ Настройки</b>\n\nОсновная валюта: ${mainCode}\nОсновной счёт: ${defaultAccountName}`
}

const SETTINGS_CAT_PAGE_PREFIX = 'settings_cat_page:'

export function categoriesListKb(
	categories: { id: string; name: string }[],
	page: number,
	selectedId: string | null,
	frozenIds: Set<string> = new Set()
) {
	const totalCount = categories.length
	const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
	const start = page * PAGE_SIZE
	const slice = categories.slice(start, start + PAGE_SIZE)
	const kb = new InlineKeyboard()
	for (let i = 0; i < slice.length; i += 3) {
		const row = slice.slice(i, i + 3)
		for (const c of row) {
			const label = frozenIds.has(c.id)
				? `${c.name} (🔒Premium)`
				: selectedId === c.id
					? `✅ ${c.name}`
					: c.name
			kb.text(label, `category:${c.id}`)
		}
		kb.row()
	}
	kb.text('« Назад', SETTINGS_CAT_PAGE_PREFIX + 'prev')
		.text(`${page + 1}/${totalPages}`, SETTINGS_CAT_PAGE_PREFIX + 'noop')
		.text('Вперёд »', SETTINGS_CAT_PAGE_PREFIX + 'next')
		.row()
	if (selectedId) {
		kb.text('🗑 Удалить', 'delete_category')
			.text('✍️ Переименовать', 'rename_category')
			.row()
			.text('Снять выделение', 'deselect_category')
			.row()
	} else {
		kb.text('+ Создать категорию', 'create_category').row()
		kb.text('← Назад', 'back_from_categories')
	}
	return kb
}

export const viewCategoriesCallback = (
	bot: Bot<BotContext>,
	categoriesService: CategoriesService,
	subscriptionService: { getFrozenItems: (userId: string) => Promise<{ customCategoryIdsOverLimit: string[] }> }
) => {
	bot.callbackQuery('view_categories', async ctx => {
		const userId = ctx.state.user.id
		const [categories, frozen] = await Promise.all([
			categoriesService.getSelectableByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		ctx.session.categoriesMessageId = msgId
		ctx.session.categoriesPage = 0
		ctx.session.categoriesSelectedId = null
		const kb = categoriesListKb(
			categories.map(c => ({ id: c.id, name: c.name })),
			0,
			null,
			frozenSet
		)
		await ctx.api.editMessageText(ctx.chat!.id, msgId, '<b>Категории</b>', {
			parse_mode: 'HTML',
			reply_markup: kb
		})
	})

	bot.callbackQuery(
		new RegExp(`^${SETTINGS_CAT_PAGE_PREFIX}(prev|next|noop)$`),
		async ctx => {
			if (ctx.session.categoriesMessageId == null) return
			const dir = ctx.callbackQuery.data.replace(SETTINGS_CAT_PAGE_PREFIX, '')
			if (dir === 'noop') return
			const userId = ctx.state.user.id
			const [categories, frozen] = await Promise.all([
				categoriesService.getSelectableByUserId(userId),
				subscriptionService.getFrozenItems(userId)
			])
			const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
			const totalPages = Math.max(1, Math.ceil(categories.length / PAGE_SIZE))
			let page = ctx.session.categoriesPage ?? 0
			if (dir === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
			else page = page >= totalPages - 1 ? 0 : page + 1
			ctx.session.categoriesPage = page
			const selectedId = ctx.session.categoriesSelectedId ?? null
			const kb = categoriesListKb(
				categories.map(c => ({ id: c.id, name: c.name })),
				page,
				selectedId,
				frozenSet
			)
			await ctx.api.editMessageText(
				ctx.chat!.id,
				ctx.session.categoriesMessageId,
				'<b>Категории</b>',
				{ parse_mode: 'HTML', reply_markup: kb }
			)
		}
	)

	bot.callbackQuery(/^category:/, async ctx => {
		if (ctx.session.categoriesMessageId == null) return
		const id = ctx.callbackQuery.data.split(':')[1]
		ctx.session.categoriesSelectedId = id
		const userId = ctx.state.user.id
		const [categories, frozen] = await Promise.all([
			categoriesService.getSelectableByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
		const page = ctx.session.categoriesPage ?? 0
		const kb = categoriesListKb(
			categories.map(c => ({ id: c.id, name: c.name })),
			page,
			id,
			frozenSet
		)
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.categoriesMessageId,
			'<b>Категории</b>',
			{ parse_mode: 'HTML', reply_markup: kb }
		)
	})

	bot.callbackQuery('deselect_category', async ctx => {
		if (ctx.session.categoriesMessageId == null) return
		ctx.session.categoriesSelectedId = null
		const userId = ctx.state.user.id
		const [categories, frozen] = await Promise.all([
			categoriesService.getSelectableByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
		const page = ctx.session.categoriesPage ?? 0
		const kb = categoriesListKb(
			categories.map(c => ({ id: c.id, name: c.name })),
			page,
			null,
			frozenSet
		)
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.categoriesMessageId,
			'<b>Категории</b>',
			{ parse_mode: 'HTML', reply_markup: kb }
		)
	})

	bot.callbackQuery('create_category', async ctx => {
		ctx.session.awaitingCategoryName = true
		ctx.session.editingCategory = 'create'
		ctx.session.categoriesMessageId = ctx.callbackQuery?.message?.message_id
		ctx.session.categoriesHintMessageId = undefined
		const hint = await ctx.reply('Введите название категории (до 20 символов)', {
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_category_hint')
		})
		ctx.session.categoriesHintMessageId = hint.message_id
	})

	bot.callbackQuery('close_category_hint', async ctx => {
		if (ctx.session.categoriesHintMessageId != null) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.session.categoriesHintMessageId
				)
			} catch {}
			ctx.session.categoriesHintMessageId = undefined
		}
		ctx.session.awaitingCategoryName = false
		ctx.session.editingCategory = undefined
	})

	bot.callbackQuery('delete_category', async ctx => {
		const selectedId = ctx.session.categoriesSelectedId
		if (!selectedId || ctx.session.categoriesMessageId == null) return
		const cat = await categoriesService.findById(selectedId, ctx.state.user.id)
		if (!cat) return
		const kb = new InlineKeyboard()
			.text('✅ Подтвердить', 'confirm_delete_category')
			.text('🔙 Вернуться', 'back_from_delete_category')
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.categoriesMessageId,
			`Удалить категорию «${cat.name}»?\n\nВы уверены?`,
			{ reply_markup: kb }
		)
	})

	bot.callbackQuery('back_from_delete_category', async ctx => {
		if (ctx.session.categoriesMessageId == null) return
		const userId = ctx.state.user.id
		const [categories, frozen] = await Promise.all([
			categoriesService.getSelectableByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
		const page = ctx.session.categoriesPage ?? 0
		const selectedId = ctx.session.categoriesSelectedId ?? null
		const kb = categoriesListKb(
			categories.map(c => ({ id: c.id, name: c.name })),
			page,
			selectedId,
			frozenSet
		)
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.categoriesMessageId,
			'<b>Категории</b>',
			{ parse_mode: 'HTML', reply_markup: kb }
		)
	})

	bot.callbackQuery('confirm_delete_category', async ctx => {
		const selectedId = ctx.session.categoriesSelectedId
		if (!selectedId || ctx.session.categoriesMessageId == null) return
		try {
			await categoriesService.delete(selectedId, ctx.state.user.id)
		} catch {
			await ctx.answerCallbackQuery({
				text: 'Не удалось удалить',
				show_alert: true
			})
			return
		}
		ctx.session.categoriesSelectedId = null
		const userId = ctx.state.user.id
		const [categories, frozen] = await Promise.all([
			categoriesService.getSelectableByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
		const page = Math.min(
			ctx.session.categoriesPage ?? 0,
			Math.max(0, Math.ceil(categories.length / PAGE_SIZE) - 1)
		)
		ctx.session.categoriesPage = page
		const kb = categoriesListKb(
			categories.map(c => ({ id: c.id, name: c.name })),
			page,
			null,
			frozenSet
		)
		await ctx.api.editMessageText(
			ctx.chat!.id,
			ctx.session.categoriesMessageId,
			'<b>Категории</b>',
			{ parse_mode: 'HTML', reply_markup: kb }
		)
	})

	bot.callbackQuery('rename_category', async ctx => {
		const selectedId = ctx.session.categoriesSelectedId
		if (!selectedId) return
		ctx.session.awaitingCategoryName = true
		ctx.session.editingCategory = 'rename'
		ctx.session.categoriesMessageId = ctx.callbackQuery?.message?.message_id
		ctx.session.categoriesHintMessageId = undefined
		const hint = await ctx.reply('Введите новое название (до 20 символов)', {
			reply_markup: new InlineKeyboard().text('Закрыть', 'close_category_hint')
		})
		ctx.session.categoriesHintMessageId = hint.message_id
	})

	bot.callbackQuery('close_category_success', async ctx => {
		try {
			await ctx.api.deleteMessage(
				ctx.chat!.id,
				ctx.callbackQuery.message!.message_id
			)
		} catch {}
	})

	bot.callbackQuery('back_from_categories', async ctx => {
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		const user: any = ctx.state.user
		await ctx.api.editMessageText(ctx.chat!.id, msgId, settingsText(user), {
			parse_mode: 'HTML',
			reply_markup: settingsKeyboard()
		})
		ctx.session.categoriesMessageId = undefined
	})
}
