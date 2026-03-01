import { createHash } from 'crypto'
import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import {
	AnalyticsService,
	type AnalyticsPeriod
} from '../../../modules/analytics/analytics.service'
import { getCurrencySymbol } from '../../../utils/format'
import {
	AiAnalyticsSnapshot,
	LLMService
} from '../../../modules/llm/llm.service'
import { PrismaService } from '../../../modules/prisma/prisma.service'
import { LlmMemoryService } from '../../../modules/llm-memory/llm-memory.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'

const AI_ANALYTICS_CACHE_TYPE = 'ai_analytics'
const AI_ANALYTICS_CACHE_KEY = 'report_v2'
const AI_RECENT_TX_LIMIT = 250
const AI_ANALYTICS_DISCLAIMER =
	'⚠️ Этот анализ не является финансовой рекомендацией.'
const AI_RATE_LIMIT_WINDOW_MS = 20_000
const AI_RATE_LIMIT_MAX = 2
const aiRateLimiter = new Map<string, { windowStart: number; count: number }>()

const MONTH_NAMES = [
	'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
	'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
]

function periodTitle(period: AnalyticsPeriod): string {
	if (period === '7d') return '7 дней'
	if (period === '30d') return '30 дней'
	if (period === '90d') return '90 дней'
	if (period === 'week') return 'текущую неделю'
	if (period === 'month') return MONTH_NAMES[new Date().getMonth()]
	if (period === '3month') return '3 месяца'
	return '3 месяца'
}

function analyticsKeyboard(period: AnalyticsPeriod) {
	const kb = new InlineKeyboard()
	kb.text(period === 'week' ? '✅ Неделя' : 'Неделя', 'analytics_week')
		.text(period === 'month' ? '✅ Месяц' : 'Месяц', 'analytics_month')
		.text(period === '3month' ? '✅ 3 месяца' : '3 месяца', 'analytics_3month')
		.row()
	kb.text(period === '7d' ? '✅ 7d' : '7d', 'analytics_7d')
		.text(period === '30d' ? '✅ 30d' : '30d', 'analytics_30d')
		.text(period === '90d' ? '✅ 90d' : '90d', 'analytics_90d')
		.row()
	kb.text('🧠 ИИ-аналитика', 'analytics_ai').row()
	kb.text('📑 Экспорт (CSV)', 'analytics_export').row()
	kb.text('← Назад', 'go_home')
	return kb
}

function fmt(num: number): string {
	return num.toLocaleString('ru-RU', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})
}

function fmtSigned(num: number): string {
	const sign = num > 0 ? '+' : num < 0 ? '-' : ''
	return `${sign}${fmt(Math.abs(num))}`
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function extractTgErrorMessage(error: unknown): string {
	const maybeAny = error as any
	return String(
		maybeAny?.description ?? maybeAny?.message ?? maybeAny ?? ''
	).toLowerCase()
}

function isNotModifiedError(error: unknown): boolean {
	return extractTgErrorMessage(error).includes('message is not modified')
}

function shouldFallbackToReply(error: unknown): boolean {
	const msg = extractTgErrorMessage(error)
	return (
		msg.includes('message to edit not found') ||
		msg.includes("message can't be edited") ||
		msg.includes('query is too old') ||
		msg.includes('message_id_invalid') ||
		msg.includes('chat not found')
	)
}

async function safeEditOrReplyHome(
	ctx: BotContext,
	text: string,
	replyMarkup: InlineKeyboard
): Promise<void> {
	const msgId = (ctx.session as any).homeMessageId as number | undefined
	if (msgId == null) {
		const msg = await ctx.reply(text, {
			parse_mode: 'HTML',
			reply_markup: replyMarkup
		})
		;(ctx.session as any).homeMessageId = msg.message_id
		return
	}
	try {
		await ctx.api.editMessageText(ctx.chat!.id, msgId, text, {
			parse_mode: 'HTML',
			reply_markup: replyMarkup
		})
		return
	} catch (error: unknown) {
		if (isNotModifiedError(error)) return
		if (!shouldFallbackToReply(error)) return
	}
	const msg = await ctx.reply(text, {
		parse_mode: 'HTML',
		reply_markup: replyMarkup
	})
	;(ctx.session as any).homeMessageId = msg.message_id
}

function buildAiAnalyticsFinalText(reportText: string): string {
	const clean = String(reportText ?? '').trim()
	const withTitle = clean.startsWith('🧠')
		? clean
		: `🧠 ИИ-аналитика\n\n${clean}`
	return `${withTitle}\n\n${AI_ANALYTICS_DISCLAIMER}`.slice(0, 3900)
}

async function sendAiAnalyticsReportMessage(
	ctx: BotContext,
	text: string
): Promise<void> {
	const replyMarkup = new InlineKeyboard().text('Закрыть', 'hide_message')
	try {
		await ctx.reply(text, {
			parse_mode: 'HTML',
			reply_markup: replyMarkup
		})
		return
	} catch (error: unknown) {
		const msg = extractTgErrorMessage(error)
		const isHtmlParseError =
			msg.includes("can't parse entities") ||
			msg.includes('parse error') ||
			msg.includes('entity')
		if (!isHtmlParseError) throw error
	}
	await ctx.reply(text.replace(/<[^>]+>/g, ''), {
		reply_markup: replyMarkup
	})
}

function consumeAiRateLimit(userId: string): boolean {
	const now = Date.now()
	const current = aiRateLimiter.get(userId)
	if (!current || now - current.windowStart > AI_RATE_LIMIT_WINDOW_MS) {
		aiRateLimiter.set(userId, { windowStart: now, count: 1 })
		return true
	}
	if (current.count >= AI_RATE_LIMIT_MAX) return false
	current.count += 1
	aiRateLimiter.set(userId, current)
	return true
}

async function buildAnalyticsFingerprint(
	prisma: PrismaService,
	userId: string
): Promise<string> {
	const [userMeta, txMeta, accountMeta, assetMeta, categoryMeta, tagMeta] =
		await Promise.all([
			prisma.user.findUnique({
				where: { id: userId },
				select: {
					mainCurrency: true,
					timezone: true,
					premiumUntil: true,
					isPremium: true
				}
			}),
			prisma.transaction.aggregate({
				where: { userId },
				_count: { _all: true },
				_max: { createdAt: true, transactionDate: true }
			}),
			prisma.account.aggregate({
				where: { userId, isHidden: false },
				_count: { _all: true },
				_max: { createdAt: true }
			}),
			prisma.accountAsset.aggregate({
				where: { account: { userId, isHidden: false } },
				_count: { _all: true }
			}),
			prisma.category.aggregate({
				where: { userId },
				_count: { _all: true },
				_max: { createdAt: true }
			}),
			prisma.tag.aggregate({
				where: { userId },
				_count: { _all: true },
				_max: { createdAt: true }
			})
		])
	const raw = JSON.stringify({
		user: {
			mainCurrency: userMeta?.mainCurrency ?? 'USD',
			timezone: userMeta?.timezone ?? 'UTC+02:00',
			isPremium: Boolean(userMeta?.isPremium),
			premiumUntil: userMeta?.premiumUntil?.toISOString() ?? null
		},
		txs: {
			count: txMeta._count._all,
			maxCreatedAt: txMeta._max.createdAt?.toISOString() ?? null,
			maxDate: txMeta._max.transactionDate?.toISOString() ?? null
		},
		accounts: {
			count: accountMeta._count._all,
			maxCreatedAt: accountMeta._max.createdAt?.toISOString() ?? null
		},
		assetsCount: assetMeta._count._all,
		categories: {
			count: categoryMeta._count._all,
			maxCreatedAt: categoryMeta._max.createdAt?.toISOString() ?? null
		},
		tags: {
			count: tagMeta._count._all,
			maxCreatedAt: tagMeta._max.createdAt?.toISOString() ?? null
		}
	})
	return createHash('sha1').update(raw).digest('hex')
}

type AiAnalyticsCachePayload = {
	fingerprint: string
	text: string
	generatedAt: string
}

async function buildAiAnalyticsSnapshot(params: {
	ctx: BotContext
	prisma: PrismaService
	analyticsService: AnalyticsService
	subscriptionService: SubscriptionService
}): Promise<AiAnalyticsSnapshot> {
	const { ctx, prisma, analyticsService, subscriptionService } = params
	const user = await prisma.user.findUnique({
		where: { id: ctx.state.user.id },
		select: {
			id: true,
			createdAt: true,
			mainCurrency: true,
			timezone: true,
			isPremium: true,
			premiumUntil: true
		}
	})
	if (!user) {
		throw new Error('user_not_found')
	}
	const mainCurrency = user.mainCurrency ?? 'USD'
	const [firstTx, accounts, recentTransactions, subscriptionView] = await Promise.all([
		prisma.transaction.findFirst({
			where: { userId: user.id },
			orderBy: { transactionDate: 'asc' },
			select: { transactionDate: true }
		}),
		prisma.account.findMany({
			where: { userId: user.id, isHidden: false },
			orderBy: { createdAt: 'asc' },
			select: {
				id: true,
				name: true,
				createdAt: true,
				assets: {
					select: { currency: true, amount: true },
					orderBy: { currency: 'asc' }
				}
			}
		}),
		prisma.transaction.findMany({
			where: { userId: user.id },
			orderBy: [{ transactionDate: 'desc' }, { createdAt: 'desc' }],
			take: AI_RECENT_TX_LIMIT,
			select: {
				id: true,
				amount: true,
				currency: true,
				direction: true,
				transactionDate: true,
				description: true,
				category: true,
				account: { select: { name: true } },
				toAccount: { select: { name: true } },
				tag: { select: { name: true } }
			}
		}),
		subscriptionService.getSubscriptionDisplay(user.id)
	])
	const [summary30d, summary90d, cashflow30d] = await Promise.all([
		analyticsService.getSummary(user.id, '30d', mainCurrency),
		analyticsService.getSummary(user.id, '90d', mainCurrency),
		analyticsService.getCashflow(user.id, '30d', mainCurrency)
	])
	const beginningBalance30d = summary30d.balance - cashflow30d
	const [topExpenseCategories30d, topIncomeCategories30d] = await Promise.all([
		analyticsService.getTopCategories(
			user.id,
			'30d',
			mainCurrency,
			5,
			undefined,
			beginningBalance30d
		),
		analyticsService.getTopIncomeCategories(
			user.id,
			'30d',
			mainCurrency,
			beginningBalance30d,
			5
		)
	])
	return {
		user: {
			id: user.id,
			createdAt: user.createdAt.toISOString(),
			mainCurrency,
			timezone: user.timezone ?? 'UTC+02:00',
			firstTransactionAt: firstTx?.transactionDate?.toISOString() ?? null
		},
		subscription: {
			isPremium: Boolean(user.isPremium),
			plan: subscriptionView.plan,
			endDate: subscriptionView.endDate?.toISOString() ?? null
		},
		accounts: accounts.map(a => ({
			id: a.id,
			name: a.name,
			createdAt: a.createdAt.toISOString(),
			assets: a.assets.map(x => ({
				currency: x.currency,
				amount: Number(x.amount ?? 0)
			}))
		})),
		transactions: {
			totalCount: await prisma.transaction.count({ where: { userId: user.id } }),
			recent: recentTransactions.map(tx => ({
				id: tx.id,
				amount: Number(tx.amount ?? 0),
				currency: tx.currency,
				direction: tx.direction,
				transactionDate: tx.transactionDate.toISOString(),
				description: tx.description,
				category: tx.category,
				tag: tx.tag?.name ?? null,
				accountName: tx.account?.name ?? null,
				toAccountName: tx.toAccount?.name ?? null
			}))
		},
		aggregates: {
			summary30d: {
				income: summary30d.income,
				expenses: summary30d.expenses,
				balance: summary30d.balance
			},
			summary90d: {
				income: summary90d.income,
				expenses: summary90d.expenses,
				balance: summary90d.balance
			},
			cashflow30d,
			topExpenseCategories30d: topExpenseCategories30d.map(x => ({
				name: x.categoryName,
				sum: x.sum,
				pct: x.pct
			})),
			topIncomeCategories30d: topIncomeCategories30d.map(x => ({
				name: x.categoryName,
				sum: x.sum,
				pct: x.pct
			}))
		}
	}
}

export async function renderAnalyticsMain(
	ctx: BotContext,
	analyticsService: AnalyticsService,
	period: AnalyticsPeriod,
	accountId?: string
): Promise<string> {
	const user = ctx.state.user as any
	const userId = user.id
	const mainCurrency = user.mainCurrency ?? 'USD'
	const symbol = getCurrencySymbol(mainCurrency)

	const timezone = (user?.timezone as string | undefined) ?? 'UTC+02:00'

	const [summary, beginningBalance] = await Promise.all([
		analyticsService.getSummary(userId, period, mainCurrency, accountId),
		analyticsService.getBeginningBalance(
			userId,
			period,
			mainCurrency,
			accountId,
			timezone
		)
	])

	const [transfersTotal, cashflow, topCategories, topIncome, topTransfers] =
		await Promise.all([
			analyticsService.getTransfersTotal(userId, period, mainCurrency, accountId),
			analyticsService.getCashflow(userId, period, mainCurrency, accountId),
			analyticsService.getTopCategories(
				userId,
				period,
				mainCurrency,
				3,
				accountId,
				beginningBalance
			),
			analyticsService.getTopIncomeCategories(
				userId,
				period,
				mainCurrency,
				beginningBalance,
				3,
				accountId
			),
			analyticsService.getTopTransfers(
				userId,
				period,
				mainCurrency,
				1,
				accountId,
				beginningBalance
			)
		])

	const title = periodTitle(period)
	const days = analyticsService.getDateRange(period)

	const monthLabel =
		period === 'month'
			? new Intl.DateTimeFormat('ru-RU', {
					month: 'long'
				}).format(new Date())
			: null
	const beginningLabel =
		period === 'month' && monthLabel
			? `💰 Капитал (1 ${monthLabel}):`
			: '💰 Капитал (начало выбранного периода):'
	const totalDays = Math.max(
		1,
		Math.ceil((days.to.getTime() - days.from.getTime()) / (24 * 60 * 60 * 1000))
	)
	const avgExpensePerDay = summary.expenses / totalDays
	const avgExpensePerDaySigned = avgExpensePerDay === 0 ? 0 : -Math.abs(avgExpensePerDay)
	const savingsRatio =
		summary.income > 0
			? Math.max(
					0,
					Math.round(((summary.income - summary.expenses) / summary.income) * 100)
				)
			: 0

	let body = `📊 <b>Финансы</b> — Обзор за ${title}

<code>${beginningLabel} ${fmt(beginningBalance)} ${symbol}
💰 Текущий капитал: ${fmt(summary.balance)} ${symbol}

🔴 Расходы: −${fmt(summary.expenses)} ${symbol}
🟢 Доходы: +${fmt(summary.income)} ${symbol}
⚪ Переводы: ${fmt(transfersTotal)} ${symbol}

<b>💸 Денежный поток:</b> ${fmtSigned(cashflow)} ${symbol}
<b>➖ Средний расход в день:</b> ${fmtSigned(avgExpensePerDaySigned)} ${symbol}

⚖️ Коэффициент сбережений: ${savingsRatio}%

— — —</code>
`

	if (topCategories.length > 0) {
		body += '<code>\n<b>Топ расходов:</b>\n</code>'
		topCategories.forEach((c, i) => {
			body += `<code>${i + 1}. ${c.categoryName} — ${fmt(c.sum)} ${symbol} (${c.pct.toFixed(0)}%)\n</code>`
			if (c.descriptionDetails?.length) {
				const txNames = c.descriptionDetails
					.map(t => `${t.description} ${fmt(t.sum)} ${symbol}`)
					.join(' · ')
				body += `<code><blockquote>${escapeHtml(txNames)}</blockquote>\n</code>`
			}
		})
	}

	if (topIncome.length > 0) {
		body += '<code>\n<b>Топ доходов:</b>\n</code>'
		topIncome.forEach((c, i) => {
			body += `<code>${i + 1}. ${c.categoryName} — ${fmt(c.sum)} ${symbol} (${c.pct.toFixed(0)}%)\n</code>`
			if (c.descriptionDetails?.length) {
				const txNames = c.descriptionDetails
					.map(t => `${t.description} ${fmt(t.sum)} ${symbol}`)
					.join(' · ')
				body += `<code><blockquote>${escapeHtml(txNames)}</blockquote>\n</code>`
			}
		})
	}

		if (topTransfers.length > 0) {
			const t = topTransfers[0]
			const headline = `${t.fromAccountName} → ${t.toAccountName} — ${fmt(t.sum)} ${symbol} (${t.pct.toFixed(0)}%)`
			body += `\n<code>Крупнейший перевод:\n${escapeHtml(headline)}\n</code>`
			const details = (t.detailItems ?? []).map(item => {
				const tagPart = item.tagName ? `, ${item.tagName}` : ''
				return `${item.label}${tagPart}, ${fmt(item.amount)} ${item.currency}`
			})
			if (details.length > 0) {
				body += `<code><blockquote>${escapeHtml(details.join('\n'))}</blockquote>\n</code>`
			}
		}

	return body.trim()
}

export const analyticsMainCallback = (
	bot: Bot<BotContext>,
	analyticsService: AnalyticsService,
	llmService: LLMService,
	prisma: PrismaService,
	llmMemoryService: LlmMemoryService,
	subscriptionService: SubscriptionService
) => {
	async function sendOrEdit(ctx: BotContext, period: AnalyticsPeriod) {
		const isPremiumPeriod = period === '90d' || period === '3month'
		if (!ctx.state.isPremium && isPremiumPeriod) {
			await ctx.answerCallbackQuery()
			await ctx.reply(
				'📈 Расширенная аналитика (90 дней и 3 месяца) доступна только в Pro.\n\nПодключите Pro-тариф, чтобы видеть долгосрочные тренды и экспортировать данные.',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
			return
		}
		;(ctx.session as any).analyticsPeriod = period
		const accountId = (ctx.session as any).analyticsFilter?.accountId
		const text = await renderAnalyticsMain(
			ctx,
			analyticsService,
			period,
			accountId
		)
		const kb = analyticsKeyboard(period)
		await safeEditOrReplyHome(ctx, text, kb)
		await ctx.answerCallbackQuery()
	}

	bot.callbackQuery('view_analytics', async ctx => {
		;(ctx.session as any).navigationStack = [
			...(ctx.session.navigationStack ?? []),
			'home'
		]
		const period = ((ctx.session as any).analyticsPeriod ?? 'month') as AnalyticsPeriod
		await sendOrEdit(ctx, period)
	})

	bot.callbackQuery('analytics_week', async ctx => sendOrEdit(ctx, 'week'))
	bot.callbackQuery('analytics_month', async ctx => sendOrEdit(ctx, 'month'))
	bot.callbackQuery('analytics_3month', async ctx => sendOrEdit(ctx, '3month'))
	bot.callbackQuery('analytics_7d', async ctx => sendOrEdit(ctx, '7d'))
	bot.callbackQuery('analytics_30d', async ctx => sendOrEdit(ctx, '30d'))
	bot.callbackQuery('analytics_90d', async ctx => sendOrEdit(ctx, '90d'))

	bot.callbackQuery('analytics_back_to_main', async ctx => {
		const period = ((ctx.session as any).analyticsPeriod ?? 'month') as AnalyticsPeriod
		await sendOrEdit(ctx, period)
	})

		bot.callbackQuery('analytics_ai', async ctx => {
			const userId = ctx.state.user.id
			if (!ctx.state.isPremium) {
			await ctx.answerCallbackQuery()
			await ctx.reply(
				'🧠 ИИ-аналитика доступна только в Pro-тарифе.',
				{
					reply_markup: new InlineKeyboard()
						.text('💠 Pro-тариф', 'view_premium')
						.row()
						.text('Закрыть', 'hide_message')
				}
			)
				return
			}
			if (!consumeAiRateLimit(userId)) {
				await ctx.answerCallbackQuery({
					text: 'Слишком часто. Повторите запрос через 20 секунд.'
				})
				return
			}

			if (ctx.session.aiAnalyticsBusy) {
			await ctx.answerCallbackQuery({ text: 'Анализ уже в обработке.' })
			return
		}
		ctx.session.aiAnalyticsBusy = true
		await ctx.answerCallbackQuery({ text: 'Запускаю ИИ-анализ…' })

		let progressMessageId: number | undefined
		try {
			const progress = await ctx.reply('🧠 ИИ-аналитика: анализирую ваши данные…')
			progressMessageId = progress.message_id
			ctx.session.aiAnalyticsProgressMessageId = progressMessageId

			const fingerprint = await buildAnalyticsFingerprint(prisma, userId)
			ctx.session.aiAnalyticsLastFingerprint = fingerprint

			const cached = await llmMemoryService.getMemoryJson<AiAnalyticsCachePayload>(
				userId,
				AI_ANALYTICS_CACHE_TYPE,
				AI_ANALYTICS_CACHE_KEY
			)
				if (
					cached &&
					cached.fingerprint === fingerprint &&
					typeof cached.text === 'string' &&
					cached.text.trim().length > 0
				) {
					await sendAiAnalyticsReportMessage(
						ctx,
						buildAiAnalyticsFinalText(cached.text)
					)
					return
				}

			const snapshot = await buildAiAnalyticsSnapshot({
				ctx,
				prisma,
				analyticsService,
				subscriptionService
			})
				const report = await llmService.generateAiAnalyticsReport(snapshot)
				const finalText = buildAiAnalyticsFinalText(String(report.text ?? ''))
				await llmMemoryService.setMemoryJson(
					userId,
					AI_ANALYTICS_CACHE_TYPE,
				AI_ANALYTICS_CACHE_KEY,
				{
					fingerprint,
					text: finalText,
						generatedAt: new Date().toISOString()
					} satisfies AiAnalyticsCachePayload
				)
				await sendAiAnalyticsReportMessage(ctx, finalText)
			} catch {
				await ctx.reply(
					'Не удалось сформировать ИИ-аналитику сейчас. Попробуйте ещё раз через минуту.',
					{
						reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
					}
				)
			} finally {
			ctx.session.aiAnalyticsBusy = false
			const pid = progressMessageId ?? ctx.session.aiAnalyticsProgressMessageId
			if (pid != null) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, pid)
				} catch {}
			}
			ctx.session.aiAnalyticsProgressMessageId = undefined
		}
	})
}
