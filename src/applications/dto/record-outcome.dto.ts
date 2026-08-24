import { IsIn, IsString } from 'class-validator';
import { OUTCOMES } from '../application.types';

export class RecordOutcomeDto {
  @IsString()
  @IsIn(OUTCOMES as unknown as string[])
  outcome!: string;
}
