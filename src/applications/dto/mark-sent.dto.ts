import { IsDateString, IsOptional } from 'class-validator';

export class MarkSentDto {
  /**
   * When the user actually submitted, if not now. Optional because the common case is "I just
   * sent it"; present because the nudge arrives a day later and the honest answer is often
   * "yesterday".
   */
  @IsOptional()
  @IsDateString()
  sentAt?: string;
}
