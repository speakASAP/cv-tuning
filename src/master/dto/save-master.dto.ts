import { IsString, MinLength } from 'class-validator';

export class SaveMasterDto {
  @IsString()
  @MinLength(1, { message: 'markdown must not be empty' })
  markdown!: string;
}
