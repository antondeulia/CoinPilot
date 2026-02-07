import { Module } from '@nestjs/common'
import { AnalyticsService } from './analytics.service'
import { ChartsService } from './charts.service'

@Module({
	providers: [AnalyticsService, ChartsService],
	exports: [AnalyticsService, ChartsService]
})
export class AnalyticsModule {}
