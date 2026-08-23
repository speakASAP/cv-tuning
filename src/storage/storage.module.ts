import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MINIO_CONFIG, MinioConfig, MinioService } from './minio.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MINIO_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MinioConfig => {
        const endpoint = config.get<string>('MINIO_ENDPOINT');
        const accessKey = config.get<string>('MINIO_ACCESS_KEY');
        const secretKey = config.get<string>('MINIO_SECRET_KEY');
        const bucket = config.get<string>('MINIO_BUCKET');

        const missing = Object.entries({ MINIO_ENDPOINT: endpoint, MINIO_ACCESS_KEY: accessKey, MINIO_SECRET_KEY: secretKey, MINIO_BUCKET: bucket })
          .filter(([, value]) => !value)
          .map(([name]) => name);

        if (missing.length > 0) {
          // Fail at boot: a half-configured store silently loses every upload.
          throw new Error(`MinIO is not configured; missing ${missing.join(', ')}`);
        }

        return { endpoint: endpoint!, accessKey: accessKey!, secretKey: secretKey!, bucket: bucket! };
      },
    },
    MinioService,
  ],
  exports: [MinioService],
})
export class StorageModule {}
