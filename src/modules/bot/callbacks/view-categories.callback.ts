import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { CategoriesService } from '../../../modules/categories/categories.service'
import { buildSettingsView } from '../../../shared/keyboards/settings'

const PAGE_SIZE = 9

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
	if (totalPages > 1) {
		kb.text('« Назад', SETTINGS_CAT_PAGE_PREFIX + 'prev')
			.text(`${page + 1}/${totalPages}`, SETTINGS_CAT_PAGE_PREFIX + 'noop')
			.text('Вперёд »', SETTINGS_CAT_PAGE_PREFIX + 'next')
			.row()
	}
	if (selectedId) {
		kb.text('🗑 Удалить', 'delete_category')
			.text('✍️ Переименовать', 'rename_category')
			.row()
			.text('← Назад', 'back_from_categories')
	} else {
		kb.text('+ Создать категорию', 'create_category').row()
		kb.text('← Назад', 'back_from_categories')
	}
	return kb
}

export const viewCategoriesCallback = (
	bot: Bot<BotContext>,
	categoriesService: CategoriesService,
	subscriptionService: { getFrozenItems: (userId: string) => Promise<{ customCategoryIdsOverLimit: string[] }> },
	prisma: { alertConfig: { count: (args: { where: { userId: string; enabled: boolean } }) => Promise<number> } }
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
		const userId = ctx.state.user.id
		const [categories, frozen] = await Promise.all([
			categoriesService.getSelectableByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customCategoryIdsOverLimit)
		if (frozenSet.has(id)) {
			await ctx.reply(
				'Категория доступна только по Premium. В Free — только дефолтные категории.',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		ctx.session.categoriesSelectedId =
			ctx.session.categoriesSelectedId === id ? null : id
		const selectedId = ctx.session.categoriesSelectedId
		const page = ctx.session.categoriesPage ?? 0
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
		const alertsEnabledCount = await prisma.alertConfig.count({
			where: { userId: user.id, enabled: true }
		})
		const view = buildSettingsView(user, alertsEnabledCount)
		await ctx.api.editMessageText(ctx.chat!.id, msgId, view.text, {
			parse_mode: 'HTML',
			reply_markup: view.keyboard
		})
		ctx.session.categoriesMessageId = undefined
	})
}
