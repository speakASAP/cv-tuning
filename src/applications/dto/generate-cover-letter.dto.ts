import { IsIn, IsOptional } from 'class-validator';
import { RENDER_LANGUAGES } from './create-application.dto';

/** Validated against the union, not merely typed as it: an unknown tone must be a 400. */
export const COVER_LETTER_TONES = ['plain', 'warm'] as const;

export class GenerateCoverLetterDto {
  @IsOptional()
  @IsIn(COVER_LETTER_TONES)
  tone?: 'plain' | 'warm';

  /** Defaults to the application's render language when omitted. */
  @IsOptional()
  @IsIn(RENDER_LANGUAGES)
  language?: string;
}
