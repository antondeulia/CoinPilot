import { Injectable } from '@nestjs/common'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import type { ChartConfiguration } from 'chart.js'
import type { AnalyticsPeriod } from './analytics.service'
import type { CategorySum } from './analytics.service'

const WIDTH = 600
const HEIGHT = 300

@Injectable()
export class ChartsService {
	private chart: ChartJSNodeCanvas

	constructor() {
		this.chart = new ChartJSNodeCanvas({ width: WIDTH, height: HEIGHT })
	}

	async generateTrendChart(
		data: { date: string; value: number }[],
		period: AnalyticsPeriod
	): Promise<Buffer> {
		const config: ChartConfiguration<'line'> = {
			type: 'line',
			data: {
				labels: data.map(d => d.date),
				datasets: [
					{
						label: 'Расходы',
						data: data.map(d => d.value),
						borderColor: 'rgb(220, 53, 69)',
						backgroundColor: 'rgba(220, 53, 69, 0.1)',
						fill: true,
						tension: 0.2
					}
				]
			},
			options: {
				responsive: true,
				plugins: {
					legend: { display: false }
				},
				scales: {
					y: { beginAtZero: true },
					x: { ticks: { maxTicksLimit: 10 } }
				}
			}
		}
		return this.chart.renderToBuffer(config)
	}

	async generateCategoryPieChart(categories: CategorySum[]): Promise<Buffer> {
		const colors = [
			'#4e79a7',
			'#f28e2b',
			'#e15759',
			'#76b7b2',
			'#59a14f',
			'#edc948',
			'#b07aa1',
			'#ff9da7',
			'#9c755f',
			'#bab0ac'
		]
		const config: ChartConfiguration<'pie'> = {
			type: 'pie',
			data: {
				labels: categories.map(c => c.categoryName),
				datasets: [
					{
						data: categories.map(c => c.sum),
						backgroundColor: categories.map((_, i) => colors[i % colors.length]),
						borderWidth: 1
					}
				]
			},
			options: {
				responsive: true,
				plugins: {
					legend: { position: 'right' }
				}
			}
		}
		return this.chart.renderToBuffer(config)
	}

	async generateBarChart(
		labels: string[],
		values: number[],
		label: string
	): Promise<Buffer> {
		const config: ChartConfiguration<'bar'> = {
			type: 'bar',
			data: {
				labels,
				datasets: [
					{
						label,
						data: values,
						backgroundColor: 'rgba(78, 121, 167, 0.7)',
						borderColor: 'rgb(78, 121, 167)',
						borderWidth: 1
					}
				]
			},
			options: {
				responsive: true,
				plugins: {
					legend: { display: false }
				},
				scales: {
					y: { beginAtZero: true },
					x: { ticks: { maxTicksLimit: 12 } }
				}
			}
		}
		return this.chart.renderToBuffer(config)
	}
}
