import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AI_SERVICE_TOKEN, AI_SERVICE_URL, AiClientService } from './ai-client.service';
import { DocumentsClientService } from './documents-client.service';

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
      provide: AI_SERVICE_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const token = config.get<string>('AI_SERVICE_TOKEN');
        if (!token) {
          throw new Error('AI_SERVICE_TOKEN is not set; cannot authenticate to ai-microservice');
        }
        return token;
      },
    },
    AiClientService,
    DocumentsClientService,
  ],
  exports: [AiClientService, DocumentsClientService],
})
export class AiModule {}
