import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { PrismaService } from '../prisma/prisma.service'

const MAX_MEMORY_ROWS_PER_USER = 200
const MAX_HINTS = 12

function makeKey(text: string): string {
	return createHash('sha1').update(text).digest('hex')
}

@Injectable()
export class LlmMemoryService {
	private readonly logger = new Logger(LlmMemoryService.name)
	private warnedMissingDelegate = false

	constructor(private readonly prisma: PrismaService) {}

	private getDelegate():
		| {
					findMany: (...args: any[]) => Promise<any[]>
					findFirst: (...args: any[]) => Promise<any | null>
					upsert: (...args: any[]) => Promise<any>
					deleteMany: (...args: any[]) => Promise<any>
		  }
		| null {
		const delegate = (this.prisma as any)?.llmUserMemory
		if (
			delegate &&
			typeof delegate.findMany === 'function' &&
			typeof delegate.findFirst === 'function' &&
			typeof delegate.upsert === 'function' &&
			typeof delegate.deleteMany === 'function'
		) {
			return delegate
		}
		if (!this.warnedMissingDelegate) {
			this.warnedMissingDelegate = true
			this.logger.warn(
				'Prisma delegate llmUserMemory is unavailable. Memory features are temporarily disabled.'
			)
		}
		return null
	}

	async getHints(userId: string): Promise<string[]> {
		const delegate = this.getDelegate()
		if (!delegate) return []
		try {
			const rows = await delegate.findMany({
				where: { userId },
				orderBy: [{ hits: 'desc' }, { updatedAt: 'desc' }],
				take: MAX_HINTS
			})
			return rows.map(r => r.value)
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.warn(`Failed to read LLM memory hints: ${err.message}`)
			return []
		}
	}

	async rememberRuleFromText(userId: string, text: string): Promise<void> {
		const raw = String(text ?? '').trim()
		if (!raw) return
		const lowered = raw.toLowerCase()
		const looksLikeRule =
			/всегда|пиши|называй|обрати внимание|сокращай|запомни|используй/u.test(
				lowered
			)
		if (!looksLikeRule) return
		const delegate = this.getDelegate()
		if (!delegate) return
		const value = raw.slice(0, 500)
		const key = makeKey(value.toLowerCase())
		try {
			await delegate.upsert({
				where: { userId_type_key: { userId, type: 'rule', key } },
				create: {
					userId,
					type: 'rule',
					key,
					value,
					confidence: 1
				},
				update: {
					value,
					hits: { increment: 1 }
				}
			})
			await this.trim(userId)
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.warn(`Failed to persist LLM memory rule: ${err.message}`)
		}
	}

	async rememberCorrection(params: {
		userId: string
		rawText?: string | null
		before: string
		after: string
		field: string
	}): Promise<void> {
		const before = String(params.before ?? '').trim()
		const after = String(params.after ?? '').trim()
		if (!before || !after || before === after) return
		const delegate = this.getDelegate()
		if (!delegate) return
		const source = String(params.rawText ?? '').trim().slice(0, 160)
		const value = `Если вход похож на "${source}", поле ${params.field}: "${before}" -> "${after}".`
		const key = makeKey(`${params.field}|${before.toLowerCase()}|${after.toLowerCase()}`)
		try {
			await delegate.upsert({
				where: { userId_type_key: { userId: params.userId, type: 'correction', key } },
				create: {
					userId: params.userId,
					type: 'correction',
					key,
					value,
					confidence: 0.9
				},
				update: {
					value,
					hits: { increment: 1 }
				}
			})
			await this.trim(params.userId)
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.warn(`Failed to persist LLM memory correction: ${err.message}`)
		}
	}

	async getMemoryValue(
		userId: string,
		type: string,
		key: string
	): Promise<string | null> {
		const delegate = this.getDelegate()
		if (!delegate) return null
		try {
			const row = await delegate.findFirst({
				where: { userId, type, key },
				select: { value: true }
			})
			return row?.value ?? null
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.warn(`Failed to read memory value: ${err.message}`)
			return null
		}
	}

	async setMemoryValue(params: {
		userId: string
		type: string
		key: string
		value: string
		confidence?: number
	}): Promise<void> {
		const delegate = this.getDelegate()
		if (!delegate) return
		const value = String(params.value ?? '').trim()
		if (!value) return
		try {
			await delegate.upsert({
				where: {
					userId_type_key: {
						userId: params.userId,
						type: params.type,
						key: params.key
					}
				},
				create: {
					userId: params.userId,
					type: params.type,
					key: params.key,
					value,
					confidence: params.confidence ?? 1
				},
				update: {
					value,
					confidence: params.confidence ?? 1,
					hits: { increment: 1 }
				}
			})
			await this.trim(params.userId)
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			this.logger.warn(`Failed to persist memory value: ${err.message}`)
		}
	}

	async getMemoryJson<T>(
		userId: string,
		type: string,
		key: string
	): Promise<T | null> {
		const raw = await this.getMemoryValue(userId, type, key)
		if (!raw) return null
		try {
			return JSON.parse(raw) as T
		} catch {
			return null
		}
	}

	async setMemoryJson(
		userId: string,
		type: string,
		key: string,
		value: unknown,
		confidence?: number
	): Promise<void> {
		await this.setMemoryValue({
			userId,
			type,
			key,
			value: JSON.stringify(value),
			confidence
		})
	}

	private async trim(userId: string): Promise<void> {
		const delegate = this.getDelegate()
		if (!delegate) return
		const rows = await delegate.findMany({
			where: { userId },
			orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
			select: { id: true },
			skip: MAX_MEMORY_ROWS_PER_USER
		})
		if (!rows.length) return
		await delegate.deleteMany({
			where: { id: { in: rows.map(r => r.id) } }
		})
	}
}
