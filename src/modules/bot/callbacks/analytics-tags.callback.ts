import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from 'src/modules/analytics/analytics.service'
import { getCurrencySymbol } from 'src/utils/format'

const PAGE_SIZE = 9

export const analyticsTagsCallback = (
	bot: Bot<BotContext>,
	analyticsService: AnalyticsService
) => {
	bot.callbackQuery('analytics_by_tag', async ctx => {
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		;(ctx.session as any).analyticsTagsPage = 0

		const tags = await analyticsService.getTopTags(
			user.id,
			period,
			user.mainCurrency ?? 'USD',
			99,
			accountId
		)
		if (!tags.length) {
			await ctx.answerCallbackQuery({ text: 'Нет расходов по тегам за период' })
			return
		}

		const page = 0
		const totalPages = Math.max(1, Math.ceil(tags.length / PAGE_SIZE))
		const slice = tags.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')

		const kb = new InlineKeyboard()
		for (let i = 0; i < slice.length; i += 3) {
			const row = slice.slice(i, i + 3)
			for (const t of row) {
				kb.text(
					`${t.tagName} ${t.sum.toFixed(0)}${symbol}`,
					`analytics_tag:${t.tagId}`
				)
			}
			kb.row()
		}
		kb.text('« Назад', 'analytics_tags_page:prev')
			.text(`1/${totalPages}`, 'analytics_tags_page:noop')
			.text('Вперёд »', 'analytics_tags_page:next')
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
					'<b>Расходы по тегам</b>\nВыберите тег:',
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})

	bot.callbackQuery(/^analytics_tags_page:/, async ctx => {
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		const tags = await analyticsService.getTopTags(
			user.id,
			period,
			user.mainCurrency ?? 'USD',
			99,
			accountId
		)
		const totalPages = Math.max(1, Math.ceil(tags.length / PAGE_SIZE))
		let page = (ctx.session as any).analyticsTagsPage ?? 0
		const action = ctx.callbackQuery.data.split(':')[1]
		if (action === 'prev') page = page <= 0 ? totalPages - 1 : page - 1
		if (action === 'next') page = page >= totalPages - 1 ? 0 : page + 1
		;(ctx.session as any).analyticsTagsPage = page

		const slice = tags.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
		const symbol = getCurrencySymbol(user.mainCurrency ?? 'USD')
		const kb = new InlineKeyboard()
		for (let i = 0; i < slice.length; i += 3) {
			const row = slice.slice(i, i + 3)
			for (const t of row) {
				kb.text(
					`${t.tagName} ${t.sum.toFixed(0)}${symbol}`,
					`analytics_tag:${t.tagId}`
				)
			}
			kb.row()
		}
		kb.text('« Назад', 'analytics_tags_page:prev')
			.text(`${page + 1}/${totalPages}`, 'analytics_tags_page:noop')
			.text('Вперёд »', 'analytics_tags_page:next')
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

	bot.callbackQuery(/^analytics_tag:/, async ctx => {
		const tagId = ctx.callbackQuery.data.replace('analytics_tag:', '')
		const user = ctx.state.user as any
		const period = ((ctx.session as any).analyticsPeriod ?? 30) as AnalyticsPeriod
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		;(ctx.session as any).analyticsTagDetailPage = 0
		;(ctx.session as any).analyticsTagDetailId = tagId

		const { transactions, total } = await analyticsService.getTagDetail(
			user.id,
			tagId,
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
		kb.text('« Назад', 'analytics_tag_detail_page:prev')
			.text(`1/${totalPages}`, 'analytics_tag_detail_page:noop')
			.text('Вперёд »', 'analytics_tag_detail_page:next')
			.row()
		kb.text('7d', 'analytics_7d')
			.text('30d', 'analytics_30d')
			.text('90d', 'analytics_90d')
			.row()
		kb.text('← К тегам', 'analytics_by_tag')

		const msgId = (ctx.session as any).homeMessageId
		if (msgId != null) {
			try {
				await ctx.api.editMessageText(
					ctx.chat!.id,
					msgId,
					`<b>Тег (id)</b>\nСумма на странице: ${sum.toFixed(0)} ${symbol}\n\n${lines.join('\n') || '—'}`,
					{ parse_mode: 'HTML', reply_markup: kb }
				)
			} catch {}
		}
	})
}
