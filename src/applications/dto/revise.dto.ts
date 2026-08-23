import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { INPUT_MODES, InputMode } from '../application.types';

export class ReviseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  instruction!: string;

  @IsIn(INPUT_MODES as unknown as string[])
  inputMode!: InputMode;
}
