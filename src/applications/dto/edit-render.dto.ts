import { IsString, MaxLength, MinLength } from 'class-validator';

export class EditRenderDto {
  // Raw markdown is retained verbatim so the export parser continues to receive its canonical
  // H1/H2/H3/bullet source, rather than a lossy reconstruction of an edited preview.
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  markdown!: string;
}
