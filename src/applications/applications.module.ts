import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { BpcpModule } from '../bpcp/bpcp.module';
import { ExportModule } from '../export/export.module';
import { JobsModule } from '../jobs/jobs.module';
import { MasterModule } from '../master/master.module';
import { StorageModule } from '../storage/storage.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { CvApplicationEntity } from './entities/cv-application.entity';
import { CvArtifactEntity } from './entities/cv-artifact.entity';
import { CvChatEntity } from './entities/cv-chat.entity';
import { CvRenderEntity } from './entities/cv-render.entity';
import { CvSupplementEntity } from './entities/cv-supplement.entity';
import { CoverLetterService } from './cover-letter.service';
import { EntailService } from './entail.service';
import { ScreeningService } from './screening.service';
import { SupplementsService } from './supplements.service';
import { ReviseService } from './revise.service';
import { TailorService } from './tailor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CvApplicationEntity,
      CvRenderEntity,
      CvChatEntity,
      CvArtifactEntity,
      CvSupplementEntity,
    ]),
    AuthModule,
    AiModule,
    MasterModule,
    JobsModule,
    ExportModule,
    StorageModule,
    BpcpModule,
  ],
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    TailorService,
    EntailService,
    ReviseService,
    CoverLetterService,
    ScreeningService,
    SupplementsService,
  ],
  exports: [ApplicationsService, SupplementsService],
})
export class ApplicationsModule {}
