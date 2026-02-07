import { Bot } from 'grammy'
import { BotContext } from '../core/bot.middleware'
import { resetToHome } from '../utils/reset-home'
import { AccountsService } from 'src/modules/accounts/accounts.service'

export const editTxCallback = (
	bot: Bot<BotContext>,
	accountsService: AccountsService
) => {
	// legacy handler отключён, новые edit-callback'и реализованы отдельно
}
