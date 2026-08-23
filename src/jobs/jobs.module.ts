import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { MasterModule } from '../master/master.module';
import { CvJobEntity } from './entities/cv-job.entity';
import { FitScorerService } from './fit-scorer.service';
import { JobFetcherService } from './job-fetcher.service';
import { JobParserService } from './job-parser.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [TypeOrmModule.forFeature([CvJobEntity]), AuthModule, AiModule, MasterModule],
  controllers: [JobsController],
  providers: [JobsService, JobFetcherService, JobParserService, FitScorerService],
  exports: [JobsService],
})
export class JobsModule {}
