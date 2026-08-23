import { IsString, MinLength } from 'class-validator';

export class SupplyTextDto {
  @IsString()
  @MinLength(40, { message: 'the posting text looks too short to be a real job description' })
  text!: string;
}
