import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AUTH_SERVICE_URL, CvAuthGuard } from './cv-auth.guard';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: AUTH_SERVICE_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('AUTH_SERVICE_URL');
        if (!url) {
          // Without this the guard would call "/auth/validate" against nothing and
          // every request would fail as an outage rather than a misconfiguration.
          throw new Error('AUTH_SERVICE_URL is not set; refusing to start without an identity provider');
        }
        return url;
      },
    },
    CvAuthGuard,
  ],
  exports: [CvAuthGuard],
})
export class AuthModule {}
