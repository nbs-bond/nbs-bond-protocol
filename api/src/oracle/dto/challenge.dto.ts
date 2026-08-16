import { IsString, IsNotEmpty, IsNumber, IsOptional, Matches } from 'class-validator';

export class ChallengeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/, {
    message: 'counterEvidenceHash must be a valid 46-character CIDv0 beginning with Qm',
  })
  counterEvidenceHash: string;

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
