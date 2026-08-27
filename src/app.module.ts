import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApplicationsModule } from './applications/applications.module';
import { BpcpModule } from './bpcp/bpcp.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { MasterModule } from './master/master.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrivacyModule } from './privacy/privacy.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, HealthModule, MasterModule, JobsModule, ApplicationsModule, BpcpModule, NotificationsModule, DashboardModule, PrivacyModule],
})
export class AppModule {}
