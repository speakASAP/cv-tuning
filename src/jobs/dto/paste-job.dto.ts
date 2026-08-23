import { IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class PasteJobDto {
  @IsString()
  @MinLength(40, { message: 'the posting text looks too short to be a real job description' })
  text!: string;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url?: string;
}
