import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeTag, tagSimilarity } from '../../utils/normalize'

export const MAX_TAG_NAME_LENGTH = 20
export const SYSTEM_MAX_CUSTOM_TAGS = 1000

const DEFAULT_TAG_NAMES = [
	'кофе',
	'завтрак',
	'обед',
	'ужин',
	'продукты',
	'супермаркет',
	'готовая еда',
	'перекус',
	'фастфуд',
	'доставка',
	'напитки',
	'алкоголь',
	'вино',
	'пиво',
	'сладости',
	'мороженое',
	'праздник',
	'здоровое питание',
	'молочные продукты',
	'бады',
	'спортивное питание',
	'такси',
	'каршеринг',
	'метро',
	'автобус',
	'поезд',
	'самолёт',
	'аэропорт',
	'бензин',
	'электрозарядка',
	'парковка',
	'ремонт авто',
	'мойка',
	'запчасти',
	'отель',
	'авиабилет',
	'аренда авто',
	'трансфер',
	'аренда жилья',
	'ипотека',
	'коммуналка',
	'электричество',
	'вода',
	'газ',
	'интернет',
	'мебель',
	'ремонт дома',
	'уборка',
	'одежда',
	'обувь',
	'электроника',
	'аптека',
	'врач',
	'медицина',
	'косметика',
	'подписка',
	'онлайн-покупка',
	'спот',
	'фьючерсы',
	'стейкинг',
	'мемкоины',
	'копитрейдинг',
	'криптовалюта',
	'Forex',
	'инвестиции',
	'зарплата',
	'фриланс',
	'обучение',
	'фитнес',
	'спортзал',
	'тренер',
	'сувениры',
	'подарок',
	'налог',
	'комиссия',
	'штраф'
]

export interface ResolveTagResult {
	tagId?: string
	tagName: string
	isNew: boolean
	isSuggestion: boolean
}

@Injectable()
export class TagsService {
	constructor(private readonly prisma: PrismaService) {}

	normalizeTag(text: string): string {
		return normalizeTag(text)
	}

	async createDefaults(userId: string) {
		const data = DEFAULT_TAG_NAMES.map(name => ({
			userId,
			name: normalizeTag(name) || name.toLowerCase(),
			isDefault: true
		})).filter(({ name }) => name.length > 0)
		await this.prisma.tag.createMany({
			data,
			skipDuplicates: true
		})
	}

	async getAllByUserId(userId: string) {
		return this.prisma.tag.findMany({
			where: { userId },
			orderBy: [{ usageCount: 'desc' }, { name: 'asc' }],
			include: { aliases: true }
		})
	}

	async getPopular(userId: string, limit: number) {
		return this.prisma.tag.findMany({
			where: { userId },
			orderBy: { usageCount: 'desc' },
			take: limit
		})
	}

	async getNamesAndAliases(
		userId: string,
		opts?: { excludeIds?: string[] }
	): Promise<string[]> {
		const where =
			(opts?.excludeIds?.length ?? 0) > 0
				? { userId, id: { notIn: opts!.excludeIds } }
				: { userId }
		const tags = await this.prisma.tag.findMany({
			where,
			include: { aliases: true }
		})
		const out: string[] = []
		for (const t of tags) {
			out.push(t.name)
			for (const a of t.aliases) out.push(a.alias)
		}
		return out
	}

	async findById(id: string, userId: string) {
		return this.prisma.tag.findFirst({
			where: { id, userId },
			include: { aliases: true }
		})
	}

	private async audit(userId: string, action: string, details: object) {
		await this.prisma.tagAuditLog.create({
			data: {
				userId,
				action,
				details: JSON.stringify(details)
			}
		})
	}

	async create(userId: string, name: string) {
		const normalized = this.normalizeTag(name).slice(0, MAX_TAG_NAME_LENGTH)
		if (!normalized) throw new Error('Название тега не может быть пустым')
		const currentCustomCount = await this.prisma.tag.count({
			where: { userId, isDefault: false }
		})
		if (currentCustomCount >= SYSTEM_MAX_CUSTOM_TAGS) {
			throw new Error(
				`Достигнут системный лимит: максимум ${SYSTEM_MAX_CUSTOM_TAGS} пользовательских тегов.`
			)
		}
		const existing = await this.prisma.tag.findFirst({
			where: { userId, name: normalized }
		})
		if (existing) return existing
		const tag = await this.prisma.tag.create({
			data: { userId, name: normalized }
		})
		await this.audit(userId, 'create', { tagId: tag.id, name: normalized })
		return tag
	}

	async delete(id: string, userId: string) {
		const tag = await this.findById(id, userId)
		if (!tag) throw new Error('Тег не найден')
		await this.prisma.tag.delete({ where: { id } })
		await this.audit(userId, 'delete', { tagId: id, name: tag.name })
	}

	async rename(id: string, userId: string, newName: string) {
		const tag = await this.findById(id, userId)
		if (!tag) throw new Error('Тег не найден')
		const normalized = this.normalizeTag(newName).slice(0, MAX_TAG_NAME_LENGTH)
		if (!normalized) throw new Error('Название тега не может быть пустым')
		const existing = await this.prisma.tag.findFirst({
			where: { userId, name: normalized, id: { not: id } }
		})
		if (existing) throw new Error('Тег с таким названием уже существует')
		const updated = await this.prisma.tag.update({
			where: { id },
			data: { name: normalized }
		})
		await this.audit(userId, 'rename', {
			tagId: id,
			from: tag.name,
			to: normalized
		})
		return updated
	}

	async incrementUsage(id: string) {
		await this.prisma.tag.update({
			where: { id },
			data: { usageCount: { increment: 1 } }
		})
	}

	async findSimilar(
		userId: string,
		normalized: string
	): Promise<{ tag: { id: string; name: string }; similarity: number }[]> {
		if (!normalized) return []
		const tags = await this.getAllByUserId(userId)
		const results: { tag: { id: string; name: string }; similarity: number }[] = []
		for (const tag of tags) {
			const sim = tagSimilarity(normalized, tag.name)
			if (sim >= 0.6)
				results.push({ tag: { id: tag.id, name: tag.name }, similarity: sim })
			for (const a of tag.aliases) {
				const asim = tagSimilarity(normalized, a.alias)
				if (asim >= 0.6)
					results.push({
						tag: { id: tag.id, name: tag.name },
						similarity: asim
					})
			}
		}
		results.sort((a, b) => b.similarity - a.similarity)
		return results.slice(0, 10)
	}

	async resolveTag(
		userId: string,
		tagText: string,
		normalizedTag: string,
		confidence: number
	): Promise<ResolveTagResult> {
		const normalized = normalizedTag
			? this.normalizeTag(normalizedTag)
			: this.normalizeTag(tagText)
		if (!normalized) return { tagName: '', isNew: false, isSuggestion: false }

		const similar = await this.findSimilar(userId, normalized)
		const best = similar[0]

		if (best && (best.similarity >= 0.75 || confidence >= 0.8)) {
			return {
				tagId: best.tag.id,
				tagName: best.tag.name,
				isNew: false,
				isSuggestion: false
			}
		}
		if (best && (best.similarity >= 0.6 || (confidence >= 0.5 && confidence < 0.8))) {
			return {
				tagId: best.tag.id,
				tagName: best.tag.name,
				isNew: false,
				isSuggestion: true
			}
		}
		if (confidence >= 0.6) {
			return {
				tagName: normalized.slice(0, MAX_TAG_NAME_LENGTH),
				isNew: true,
				isSuggestion: false
			}
		}
		return { tagName: '', isNew: false, isSuggestion: false }
	}

	async addAlias(tagId: string, alias: string) {
		const normalized = this.normalizeTag(alias).slice(0, MAX_TAG_NAME_LENGTH)
		if (!normalized) throw new Error('Алиас не может быть пустым')
		const tag = await this.prisma.tag.findUnique({ where: { id: tagId } })
		if (!tag) throw new Error('Тег не найден')
		await this.prisma.tagAlias.create({
			data: { tagId, alias: normalized }
		})
	}

	async getAliases(tagId: string) {
		return this.prisma.tagAlias.findMany({
			where: { tagId },
			select: { alias: true }
		})
	}
}
