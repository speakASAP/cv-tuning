import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { CvFactEntity } from './entities/cv-fact.entity';
import { CvMasterEntity } from './entities/cv-master.entity';
import { CvProfileEntity } from './entities/cv-profile.entity';
import { FactExtractorService } from './fact-extractor.service';
import { DocumentImporter } from './importers/document.importer';
import { GdocsImporter } from './importers/gdocs.importer';
import { LinkedinImporter } from './importers/linkedin.importer';
import { MasterCvController } from './master-cv.controller';
import { MasterCvService } from './master-cv.service';

@Module({
  imports: [TypeOrmModule.forFeature([CvProfileEntity, CvMasterEntity, CvFactEntity]), AuthModule, AiModule, StorageModule],
  controllers: [MasterCvController],
  providers: [MasterCvService, FactExtractorService, GdocsImporter, DocumentImporter, LinkedinImporter],
  exports: [MasterCvService],
})
export class MasterModule {}
