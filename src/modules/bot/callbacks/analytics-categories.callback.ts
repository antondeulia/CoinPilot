import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from 'src/modules/analytics/analytics.service'
import { PrismaService } from 'src/modules/prisma/prisma.service'
import { getCurrencySymbol } from 'src/utils/format'

const PAGE_SIZE = 9

export const analyticsCategoriesCallback = (
	bot: Bot<BotContext>,
	analyticsService: AnalyticsService,
	prisma: PrismaService
) => {
	bot.callbackQuery('analytics_by_category', async ctx => {
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		;(ctx.session as any).analyticsCategoriesPage = 0

		const categories = await analyticsService.getTopCategories(
			user.id,
			period,
			user.mainCurrency ?? 'USD',
			99,
			accountId
		)
		if (!categories.length) {
			await ctx.answerCallbackQuery({
				text: 'Нет расходов по категориям за период'
			})
			return
		}

		const page = 0
		const totalPages = Math.max(1, Math.ceil(categories.length / PAGE_SIZE))
		const slice = categories.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')

		const kb = new InlineKeyboard()
		for (let i = 0; i < slice.length; i += 3) {
			const row = slice.slice(i, i + 3)
			for (const c of row) {
				const label = `${c.categoryName} ${c.sum.toFixed(0)}${symbol}`
				kb.text(
					label.slice(0, 60),
					`analytics_category:${c.categoryId ?? c.categoryName}`
				)
			}
			kb.row()
		}
		kb.text('« Назад', 'analytics_categories_page:prev')
			.text(`1/${totalPages}`, 'analytics_categories_page:noop')
			.text('Вперёд »', 'analytics_categories_page:next')
			.row()
		kb.text('7d', 'analytics_7d')
			.text('30d', 'analytics_30d')
			.text('90d', 'analytics_90d')
			.row()
		kb.text('← Назад', 'analytics_back_to_main')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					'<b>Расходы по категориям</b>\nВыберите категорию:',
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^analytics_categories_page:/, async ctx => {
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		const categories = await analyticsService.getTopCategories(
			user.id,
			period,
			user.mainCurrency ?? 'USD',
			99,
			accountId
		)
		const totalPages = Math.max(1, Math.ceil(categories.length / PAGE_SIZE))
		let page = (ctx.session as any).analyticsCategoriesPage ?? 0
		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		;(ctx.session as any).analyticsCategoriesPage = page

		const slice = categories.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')
		const kb = new InlineKeyboard()
		for (let i = 0; i < slice.length; i += 3) {
			const row = slice.slice(i, i + 3)
			for (const c of row) {
				const label = `${c.categoryName} ${c.sum.toFixed(0)}${symbol}`
				kb.text(
					label.slice(0, 60),
					`analytics_category:${c.categoryId ?? c.categoryName}`
				)
			}
			kb.row()
		}
		kb.text('« Назад', 'analytics_categories_page:prev')
			.text(`${page + 1}/${totalPages}`, 'analytics_categories_page:noop')
			.text('Вперёд »', 'analytics_categories_page:next')
			.row()
		kb.text('7d', 'analytics_7d')
			.text('30d', 'analytics_30d')
			.text('90d', 'analytics_90d')
			.row()
		kb.text('← Назад', 'analytics_back_to_main')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageReplyMarkup(ctx.chat!.id, msgId, {
					reply_markup: kb
				})
			} catch {}
		}
	})

	bot.callbackQuery(/^analytics_category:/, async ctx => {
		const categoryIdOrName = ctx.callbackQuery.data.replace('analytics_category:', '')
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		;(ctx.session as any).analyticsCategoryDetailPage = 0
		;(ctx.session as any).analyticsCategoryDetailId = categoryIdOrName

		let categoryName = categoryIdOrName
		if (categoryIdOrName && /^[0-9a-f-]{36}$/i.test(categoryIdOrName)) {
			const found = await prisma.category.findFirst({
				where: { id: categoryIdOrName, userId: user.id },
				select: { name: true }
			})
			if (found) categoryName = found.name
		}

		const { transactions, total } = await analyticsService.getCategoryDetail(
			user.id,
			categoryName,
			period,
			0,
			9,
			user.mainCurrency ?? 'USD',
			accountId
		)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')
		const totalPages = Math.max(1, Math.ceil(total / 9))
		const lines = transactions.map(
			t =>
				`• ${(t.description ?? '—').slice(0, 25)} ${t.amount.toFixed(0)} ${symbol} ${new Date(t.transactionDate).toLocaleDateString('ru-RU')}`
		)
		const sum = transactions.reduce((a, t) => a + t.amount, 0)

		const kb = new InlineKeyboard()
		kb.text('« Назад', 'analytics_category_detail_page:prev')
			.text(`1/${totalPages}`, 'analytics_category_detail_page:noop')
			.text('Вперёд »', 'analytics_category_detail_page:next')
			.row()
		kb.text('7d', 'analytics_7d')
			.text('30d', 'analytics_30d')
			.text('90d', 'analytics_90d')
			.row()
		kb.text('← К категориям', 'analytics_by_category')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					`<b>Категория: ${categoryName}</b>\nСумма на странице: ${sum.toFixed(0)} ${symbol}\n\n${lines.join('\n') || '—'}`,
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^analytics_category_detail_page:/, async ctx => {
		const categoryName = (ctx.session as any).analyticsCategoryDetailId
		if (!categoryName) return
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		let page = (ctx.session as any).analyticsCategoryDetailPage ?? 0
		const action = ctx.callbackQuery.data.split(':')[1]
		const { total } = await analyticsService.getCategoryDetail(
			user.id,
			categoryName,
			period,
			0,
			1,
			user.mainCurrency ?? 'USD',
			accountId
		)
		const totalPages = Math.max(1, Math.ceil(total / 9))
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		;(ctx.session as any).analyticsCategoryDetailPage = page

		const { transactions: finalTxs } = await analyticsService.getCategoryDetail(
			user.id,
			categoryName,
			period,
			page,
			9,
			user.mainCurrency ?? 'USD',
			accountId
		)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')
		const lines = finalTxs.map(
			t =>
				`• ${(t.description ?? '—').slice(0, 25)} ${t.amount.toFixed(0)} ${symbol} ${new Date(t.transactionDate).toLocaleDateString('ru-RU')}`
		)
		const sum = finalTxs.reduce((a, t) => a + t.amount, 0)

		const kb = new InlineKeyboard()
		kb.text('« Назад', 'analytics_category_detail_page:prev')
			.text(`${page + 1}/${totalPages}`, 'analytics_category_detail_page:noop')
			.text('Вперёд »', 'analytics_category_detail_page:next')
			.row()
		kb.text('7d', 'analytics_7d')
			.text('30d', 'analytics_30d')
			.text('90d', 'analytics_90d')
			.row()
		kb.text('← К категориям', 'analytics_by_category')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					`<b>Категория: ${categoryName}</b>\nСумма на странице: ${sum.toFixed(0)} ${symbol}\n\n${lines.join('\n') || '—'}`,
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})
}
