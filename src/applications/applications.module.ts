import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { MasterModule } from '../master/master.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { CvApplicationEntity } from './entities/cv-application.entity';
import { CvRenderEntity } from './entities/cv-render.entity';
import { EntailService } from './entail.service';
import { TailorService } from './tailor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CvApplicationEntity, CvRenderEntity]),
    AuthModule,
    AiModule,
    MasterModule,
    JobsModule,
  ],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, TailorService, EntailService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
