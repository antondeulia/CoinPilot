import { Bot, InlineKeyboard } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { TagsService } from '../../../modules/tags/tags.service'
import { buildSettingsView } from '../../../shared/keyboards/settings'

function tagsSettingsKeyboard() {
	return new InlineKeyboard()
		.text('Jarvis-редактирование', 'tags_jarvis_edit')
		.row()
		.text('← Назад', 'back_from_tags')
}

export function tagsListText(
	tags: { id: string; name: string }[],
	frozenIds: Set<string>
) {
	const active = tags.filter(t => !frozenIds.has(t.id)).map(t => t.name)
	const frozen = tags.filter(t => frozenIds.has(t.id)).map(t => t.name)
	const activeStr = active.length > 0 ? active.join(', ') : '—'
	let text = `<b>Теги</b>\n\nСписок ваших тегов:\n<blockquote>${activeStr}</blockquote>`
	if (frozen.length > 0) {
		text += `\n\n🔒 Доступно в Premium:\n${frozen.join(', ')}`
	}
	return text
}

export const viewTagsCallback = (
	bot: Bot<BotContext>,
	tagsService: TagsService,
	subscriptionService: { getFrozenItems: (userId: string) => Promise<{ customTagIdsOverLimit: string[] }> },
	prisma: { alertConfig: { count: (args: { where: { userId: string; enabled: boolean } }) => Promise<number> } }
) => {
	bot.callbackQuery('view_tags', async ctx => {
		const userId = ctx.state.user.id
		const [tags, frozen] = await Promise.all([
			tagsService.getAllByUserId(userId),
			subscriptionService.getFrozenItems(userId)
		])
		const frozenSet = new Set(frozen.customTagIdsOverLimit)
		const msgId = ctx.callbackQuery?.message?.message_id
		if (msgId == null) return
		ctx.session.tagsSettingsMessageId = msgId
		await ctx.api.editMessageText(
			ctx.chat!.id,
			msgId,
			tagsListText(tags.map(t => ({ id: t.id, name: t.name })), frozenSet),
			{
				parse_mode: 'HTML',
				reply_markup: tagsSettingsKeyboard()
			}
		)
	})

	bot.callbackQuery('tags_jarvis_edit', async ctx => {
		ctx.session.awaitingTagsJarvisEdit = true
		const msg = await ctx.reply(
			'Опишите изменения: удали теги X, Y; добавь A, B; переименуй C в D. После отправки сообщения изменения применятся.',
			{
				parse_mode: 'HTML',
				reply_markup: new InlineKeyboard().text('Закрыть', 'close_tags_jarvis')
			}
		)
		ctx.session.tagsSettingsHintMessageId = msg.message_id
	})

	bot.callbackQuery('close_tags_jarvis', async ctx => {
		if (ctx.session.tagsSettingsHintMessageId != null) {
			try {
				await ctx.api.deleteMessage(
					ctx.chat!.id,
					ctx.session.tagsSettingsHintMessageId
				)
			} catch {}
			ctx.session.tagsSettingsHintMessageId = undefined
		}
		ctx.session.awaitingTagsJarvisEdit = false
	})

	bot.callbackQuery('back_from_tags', async ctx => {
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
		ctx.session.tagsSettingsMessageId = undefined
	})
}
