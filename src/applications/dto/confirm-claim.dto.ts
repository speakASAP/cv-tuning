import { IsIn, IsString, MinLength } from 'class-validator';

export class ConfirmClaimDto {
  @IsString()
  @MinLength(1)
  bulletText!: string;

  @IsIn(['confirm', 'drop'])
  decision!: 'confirm' | 'drop';
}
