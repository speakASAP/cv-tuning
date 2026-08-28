import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { CvArtifactEntity } from '../applications/entities/cv-artifact.entity';
import { CvChatEntity } from '../applications/entities/cv-chat.entity';
import { CvRenderEntity } from '../applications/entities/cv-render.entity';
import { CvSupplementEntity } from '../applications/entities/cv-supplement.entity';
import { AuthModule } from '../auth/auth.module';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { CvMasterEntity } from '../master/entities/cv-master.entity';
import { CvProfileEntity } from '../master/entities/cv-profile.entity';
import { StorageModule } from '../storage/storage.module';
import { AccountDeletionService } from './account-deletion.service';
import { DataExportService } from './data-export.service';
import {
  AUTH_USER_LOOKUP_SERVICE_NAME,
  AUTH_USER_LOOKUP_TOKEN,
  AUTH_USER_LOOKUP_URL,
  HttpIdentityProvider,
  IDENTITY_PROVIDER,
  IdentityProviderPort,
} from './identity-provider';
import { OffboardingService } from './offboarding.service';
import { PrivacyController } from './privacy.controller';
import { RetentionService } from './retention.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CvProfileEntity,
      CvMasterEntity,
      CvFactEntity,
      CvJobEntity,
      CvApplicationEntity,
      CvRenderEntity,
      CvChatEntity,
      CvArtifactEntity,
      CvSupplementEntity,
    ]),
    ConfigModule,
    AuthModule,
    StorageModule,
  ],
  controllers: [PrivacyController],
  providers: [
    DataExportService,
    AccountDeletionService,
    RetentionService,
    OffboardingService,
    {
      // Optional: unset in the current deployment, which keeps offboarding safely blocked.
      provide: AUTH_USER_LOOKUP_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string | null => config.get<string>('AUTH_USER_LOOKUP_URL') ?? null,
    },
    {
      provide: AUTH_USER_LOOKUP_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string | null => config.get<string>('AUTH_USER_LOOKUP_TOKEN') ?? null,
    },
    {
      provide: AUTH_USER_LOOKUP_SERVICE_NAME,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string => config.get<string>('AUTH_USER_LOOKUP_SERVICE_NAME') ?? 'cv-tuning',
    },
    {
      provide: IDENTITY_PROVIDER,
      inject: [AUTH_USER_LOOKUP_URL, AUTH_USER_LOOKUP_TOKEN, AUTH_USER_LOOKUP_SERVICE_NAME],
      useFactory: (lookupUrl: string | null, lookupToken: string | null, serviceName: string): IdentityProviderPort =>
        new HttpIdentityProvider(lookupUrl, lookupToken, serviceName),
    },
  ],
})
export class PrivacyModule {}
