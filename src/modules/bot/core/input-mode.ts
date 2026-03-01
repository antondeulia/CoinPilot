import type { BotContext, InputMode } from './bot.middleware'

type SessionPatch = Partial<BotContext['session']>

function clearBooleanModes(ctx: BotContext): void {
	ctx.session.awaitingTransaction = false
	ctx.session.awaitingAccountInput = false
	ctx.session.awaitingTagInput = false
	ctx.session.awaitingTagsJarvisEdit = false
	ctx.session.awaitingCategoryName = false
	;(ctx.session as any).awaitingDeleteConfirm = false
	;(ctx.session as any).editingCurrency = false
	;(ctx.session as any).editingMainCurrency = false
	ctx.session.awaitingInlineCategoryCreate = false
	ctx.session.awaitingInlineTagCreate = false
	ctx.session.awaitingMassAccountsInput = false
	ctx.session.awaitingMassTransactionsInput = false
	ctx.session.pendingTransactionDraft = undefined
	ctx.session.pendingTransactionMissing = undefined
	ctx.session.pendingAccountInputText = undefined
	ctx.session.autoCreatedTxIdsForCurrentParse = undefined
	ctx.session.newTagNamesInSession = undefined
	ctx.session.repeatTxConfirmMessageId = undefined
	ctx.session.massAccountsDraft = undefined
	ctx.session.massAccountsSummaryMessageId = undefined
	ctx.session.massAccountsBusy = false
	ctx.session.massTransactionsDraft = undefined
	ctx.session.massTransactionsSummaryMessageId = undefined
	ctx.session.massTransactionsBusy = false
}

function clearEditingModes(ctx: BotContext): void {
	ctx.session.editingField = undefined
	ctx.session.editingAccountField = undefined
	ctx.session.editingAccountDetailsId = undefined
	ctx.session.accountDetailsEditMode = undefined
	ctx.session.editingCategory = undefined
}

export function resetInputModes(ctx: BotContext, patch?: SessionPatch): void {
	ctx.session.inputMode = 'idle'
	clearBooleanModes(ctx)
	clearEditingModes(ctx)
	if (patch) Object.assign(ctx.session, patch)
}

export function activateInputMode(
	ctx: BotContext,
	mode: InputMode,
	patch?: SessionPatch
): void {
	resetInputModes(ctx)
	ctx.session.inputMode = mode
	if (patch) Object.assign(ctx.session, patch)
}

export function isInputMode(ctx: BotContext, mode: InputMode): boolean {
	return (ctx.session.inputMode ?? 'idle') === mode
}
