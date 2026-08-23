import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CvJobEntity } from '../jobs/entities/cv-job.entity';
import { CvFactEntity } from '../master/entities/cv-fact.entity';
import { CvMasterEntity } from '../master/entities/cv-master.entity';
import { CvProfileEntity } from '../master/entities/cv-profile.entity';

export const CV_ENTITIES = [CvProfileEntity, CvMasterEntity, CvFactEntity, CvJobEntity];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('CV_DATABASE_URL');
        if (!url) {
          // Fail fast: a missing DSN must never degrade to an in-memory store.
          throw new Error('CV_DATABASE_URL is not set; refusing to start without a database');
        }
        return {
          type: 'postgres' as const,
          url,
          entities: CV_ENTITIES,
          migrations: [`${__dirname}/migrations/*.js`],
          migrationsRun: true,
          synchronize: false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
