import { IsIn, IsString, MinLength } from 'class-validator';

export class ConfirmClaimDto {
  /**
   * The `TailoredBullet.bulletId` from the render view, NOT the bullet's text. Text was
   * ambiguous between two identical-text bullets, which made the second permanently
   * undecidable — see `bullet-identity.ts`.
   */
  @IsString()
  @MinLength(1)
  bulletId!: string;

  @IsIn(['confirm', 'drop'])
  decision!: 'confirm' | 'drop';
}
