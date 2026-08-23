import { IsIn, IsOptional, IsUUID } from 'class-validator';

/** CZ/EN/RU is the realistic v1 set (spec §4.3). */
export const RENDER_LANGUAGES = ['en', 'cs', 'ru'] as const;

export class CreateApplicationDto {
  @IsUUID()
  jobId!: string;

  /** Defaults to the posting's detected language when omitted. */
  @IsOptional()
  @IsIn(RENDER_LANGUAGES)
  renderLanguage?: string;
}
