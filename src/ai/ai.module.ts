import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AI_JWT_SECRET, AI_SERVICE_URL, AiClientService } from './ai-client.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: AI_SERVICE_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('AI_SERVICE_URL');
        if (!url) throw new Error('AI_SERVICE_URL is not set; refusing to start without an inference gateway');
        return url;
      },
    },
    {
      provide: AI_JWT_SECRET,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret) {
          // /ai/complete sits behind ServiceAuthGuard; without this every call 401s.
          throw new Error('JWT_SECRET is not set; cannot authenticate to ai-microservice');
        }
        return secret;
      },
    },
    AiClientService,
  ],
  exports: [AiClientService],
})
export class AiModule {}
