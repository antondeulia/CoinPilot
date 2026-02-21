import { Injectable } from '@nestjs/common'
import { createHash } from 'crypto'
import { PrismaService } from '../prisma/prisma.service'

const MAX_MEMORY_ROWS_PER_USER = 200
const MAX_HINTS = 12

function makeKey(text: string): string {
	return createHash('sha1').update(text).digest('hex')
}

@Injectable()
export class LlmMemoryService {
	constructor(private readonly prisma: PrismaService) {}

	async getHints(userId: string): Promise<string[]> {
		const prismaAny = this.prisma as any
		const rows = await prismaAny.llmUserMemory.findMany({
			where: { userId },
			orderBy: [{ hits: 'desc' }, { updatedAt: 'desc' }],
			take: MAX_HINTS
		})
		return rows.map(r => r.value)
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
		const value = raw.slice(0, 500)
		const key = makeKey(value.toLowerCase())
		const prismaAny = this.prisma as any
		await prismaAny.llmUserMemory.upsert({
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
		const source = String(params.rawText ?? '').trim().slice(0, 160)
		const value = `Если вход похож на "${source}", поле ${params.field}: "${before}" -> "${after}".`
		const key = makeKey(`${params.field}|${before.toLowerCase()}|${after.toLowerCase()}`)
		const prismaAny = this.prisma as any
		await prismaAny.llmUserMemory.upsert({
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
	}

	private async trim(userId: string): Promise<void> {
		const prismaAny = this.prisma as any
		const rows = await prismaAny.llmUserMemory.findMany({
			where: { userId },
			orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
			select: { id: true },
			skip: MAX_MEMORY_ROWS_PER_USER
		})
		if (!rows.length) return
		await prismaAny.llmUserMemory.deleteMany({
			where: { id: { in: rows.map(r => r.id) } }
		})
	}
}
