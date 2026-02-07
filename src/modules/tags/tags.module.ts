import { Module } from '@nestjs/common'
import { TagsService } from './tags.service'

@Module({
	providers: [TagsService],
	exports: [TagsService]
})
export class TagsModule {}
