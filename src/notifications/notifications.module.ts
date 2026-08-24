import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import {
  NotificationClientService,
  NOTIFICATIONS_SERVICE_URL,
} from './notification-client.service';
import { NudgeController, NUDGE_CALLBACK_SECRET, NUDGE_RECIPIENT } from './nudge.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CvApplicationEntity, CvJobEntity])],
  controllers: [NudgeController],
  providers: [
    NotificationClientService,
    {
      provide: NOTIFICATIONS_SERVICE_URL,
      useFactory: () => process.env.CV_NOTIFICATIONS_SERVICE_URL,
    },
    { provide: NUDGE_CALLBACK_SECRET, useFactory: () => process.env.CV_NUDGE_CALLBACK_SECRET ?? '' },
    { provide: NUDGE_RECIPIENT, useFactory: () => process.env.CV_NUDGE_RECIPIENT ?? '' },
  ],
  exports: [NotificationClientService],
})
export class NotificationsModule {}
