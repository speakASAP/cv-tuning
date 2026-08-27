import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { RENDER_LANGUAGES } from './create-application.dto';

/**
 * A paste accident must not build an unbounded prompt. 25 is far above any real application
 * form and far below anything that would blow the context window or the bill.
 */
export const MAX_SCREENING_QUESTIONS = 25;

export class GenerateScreeningDto {
  /**
   * Questions the user pasted from the employer's own portal. Merged with the parsed ones,
   * where these win every tie — see `screening-questions.ts`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCREENING_QUESTIONS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  questions?: string[];

  @IsOptional()
  @IsIn(RENDER_LANGUAGES)
  language?: string;
}
