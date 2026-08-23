import { IsString, IsUrl } from 'class-validator';

export class SubmitJobDto {
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url!: string;
}
