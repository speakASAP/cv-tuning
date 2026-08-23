import { IsString, IsUrl } from 'class-validator';

export class ImportGdocsDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  url!: string;
}
