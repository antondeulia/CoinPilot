import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class CategoriesService {
	constructor(private readonly prisma: PrismaService) {}

	async createDefaults(userId: string) {
		const names = [
			'Еда и напитки',
			'Транспорт',
			'Жильё',
			'Покупки',
			'Кафе и рестораны',
			'Здоровье',
			'Развлечения',
			'Платежи',
			'Финансовые расходы',
			'Путешествия',
			'Доход',
			'Инвестиции',
			'Автомобиль',
			'Не выбрано'
		]

		await this.prisma.category.createMany({
			data: names.map(name => ({ userId, name })),
			skipDuplicates: true
		})
	}

	async getAllByUserId(userId: string) {
		return this.prisma.category.findMany({
			where: { userId },
			orderBy: { createdAt: 'asc' }
		})
	}

	async findById(id: string, userId: string) {
		return this.prisma.category.findFirst({
			where: { id, userId }
		})
	}

	/** Категории для выбора в UI (без скрытой "Не выбрано") */
	async getSelectableByUserId(userId: string) {
		return this.prisma.category.findMany({
			where: { userId, name: { not: 'Не выбрано' } },
			orderBy: { createdAt: 'asc' }
		})
	}

	async create(userId: string, name: string) {
		const trimmed = name.trim().slice(0, 20)
		if (!trimmed) throw new Error('Название не может быть пустым')
		const existing = await this.prisma.category.findFirst({
			where: { userId, name: trimmed }
		})
		if (existing) throw new Error('Категория с таким названием уже существует')
		return this.prisma.category.create({
			data: { userId, name: this.capitalize(trimmed) }
		})
	}

	async update(id: string, userId: string, name: string) {
		const cat = await this.findById(id, userId)
		if (!cat) throw new Error('Категория не найдена')
		if (cat.name === 'Не выбрано') throw new Error('Эту категорию нельзя переименовать')
		const trimmed = name.trim().slice(0, 20)
		if (!trimmed) throw new Error('Название не может быть пустым')
		const existing = await this.prisma.category.findFirst({
			where: { userId, name: trimmed, id: { not: id } }
		})
		if (existing) throw new Error('Категория с таким названием уже существует')
		return this.prisma.category.update({
			where: { id },
			data: { name: this.capitalize(trimmed) }
		})
	}

	async delete(id: string, userId: string) {
		const cat = await this.findById(id, userId)
		if (!cat) throw new Error('Категория не найдена')
		if (cat.name === 'Не выбрано') throw new Error('Эту категорию нельзя удалить')
		return this.prisma.category.delete({
			where: { id }
		})
	}

	private capitalize(s: string) {
		if (!s.length) return s
		return s[0].toUpperCase() + s.slice(1).toLowerCase()
	}
}

