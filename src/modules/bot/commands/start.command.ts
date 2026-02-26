import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { AccountsService } from '../../../modules/accounts/accounts.service'
import { AnalyticsService } from '../../../modules/analytics/analytics.service'
import { PrismaService } from '../../../modules/prisma/prisma.service'
import { SubscriptionService } from '../../../modules/subscription/subscription.service'
import { renderHome } from '../utils/render-home'
import { resetInputModes } from '../core/input-mode'

const ONBOARDING_START_TEXT = `💼 Первый шаг — создать основу для учёта. Сейчас тебе нужно перейти в раздел <b>«Счета»</b> и добавить свои первые два счёта через кнопку <b>«➕ Добавить счёт»</b>. Это поможет боту понять твою финансовую структуру и правильно вести аналитику.`
const ONBOARDING_SUPPRESS_AFTER_DELETE_MARKER =
	'onboarding_suppressed_after_delete_v1'

async function deleteMessageBestEffort(
	ctx: BotContext,
	messageId?: number
): Promise<void> {
	if (messageId == null) return
	try {
		await ctx.api.deleteMessage(ctx.chat!.id, messageId)
	} catch {}
}

export const startCommand = (
	bot: Bot<BotContext>,
	accountsService: AccountsService,
	analyticsService: AnalyticsService,
	prisma: PrismaService,
	subscriptionService: SubscriptionService
) => {
			bot.command('start', async ctx => {
				const keep = new Set<number>((ctx.session.resultMessageIds ?? []) as number[])
			if (
				ctx.session.tempMessageId != null &&
				!keep.has(ctx.session.tempMessageId) &&
				ctx.session.tempMessageId !== ctx.session.previewMessageId
			) {
				try {
					await ctx.api.deleteMessage(ctx.chat!.id, ctx.session.tempMessageId)
				} catch {}
			}
				resetInputModes(ctx, { homeMessageId: ctx.session.homeMessageId })
			;(ctx.session as any).editingCurrency = false
		;(ctx.session as any).editingMainCurrency = false
		;(ctx.session as any).editingTimezone = false
		ctx.session.editingField = undefined
		ctx.session.editMessageId = undefined
		ctx.session.accountsPage = undefined
		ctx.session.accountsViewPage = undefined
		ctx.session.accountsViewSelectedId = undefined
		ctx.session.editingAccountField = undefined
		ctx.session.editingAccountDetailsId = undefined
		ctx.session.categoriesPage = undefined
		ctx.session.categoriesSelectedId = undefined
		ctx.session.awaitingTransaction = false
		;(ctx.session as any).awaitingTagInput = false
		;(ctx.session as any).awaitingTagsJarvisEdit = false
		ctx.session.awaitingAccountInput = false
		;(ctx.session as any).awaitingCategoryName = false
		ctx.session.confirmingTransaction = false
		;(ctx.session as any).confirmingAccounts = false
		ctx.session.draftTransactions = undefined
		;(ctx.session as any).draftAccounts = undefined
		ctx.session.currentTransactionIndex = undefined
		;(ctx.session as any).currentAccountIndex = undefined
		ctx.session.tempMessageId = undefined
		ctx.session.navigationStack = undefined
		ctx.session.tagsPage = undefined
		;(ctx.session as any).editingCategory = undefined
		;(ctx.session as any).tagsSettingsMessageId = undefined
		;(ctx.session as any).tagsSettingsHintMessageId = undefined
		;(ctx.session as any).editingTransactionId = undefined
		;(ctx.session as any).timezoneHintMessageId = undefined
			;(ctx.session as any).timezoneErrorMessageIds = undefined
			;(ctx.session as any).accountDeltaPromptMessageId = undefined
			;(ctx.session as any).pendingAccountDeltaOps = undefined

				const user = ctx.state.user as any
				const onboardingSuppressed = await subscriptionService.hasMarker(
					user.id,
					ONBOARDING_SUPPRESS_AFTER_DELETE_MARKER
				)
				const visibleAccountsCount = (user?.accounts ?? []).filter(
					(a: { isHidden?: boolean }) => !a.isHidden
				).length
				let shouldSendOnboardingStart = false
				if (!onboardingSuppressed && visibleAccountsCount === 0) {
					const txCount = await prisma.transaction.count({
						where: { userId: user.id }
					})
					if (txCount === 0) {
					shouldSendOnboardingStart = await subscriptionService.markMarkerIfAbsent(
						user.id,
						'onboarding_start_v1'
					)
				}
			}

				await renderHome(ctx, accountsService, analyticsService)

				if (shouldSendOnboardingStart) {
					await deleteMessageBestEffort(
						ctx,
						ctx.session.onboardingStartMessageId
					)
						const message = await ctx.reply(ONBOARDING_START_TEXT, {
							parse_mode: 'HTML',
							reply_markup: new InlineKeyboard().text('Закрыть', 'hide_message')
						})
					ctx.session.onboardingStartMessageId = message.message_id
				} else if (onboardingSuppressed) {
					ctx.session.onboardingStartMessageId = undefined
					ctx.session.onboardingAccountsMessageId = undefined
				}
			})
		}
