import { IsString, IsNotEmpty, Matches } from 'class-validator';

/**
 * Body for the first step of the pre-signed-transaction challenge flow:
 * POST /oracle/challenge/:reportId/prepare. Returns an unsigned transaction
 * XDR for the challenger's own wallet to sign.
 */
export class PrepareChallengeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/, {
    message: 'counterEvidenceHash must be a valid 46-character CIDv0 beginning with Qm',
  })
  counterEvidenceHash: string;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

/**
 * Body for POST /oracle/challenge/:reportId. `signedTxXdr` is the base64
 * envelope returned by the /prepare step, signed externally by the
 * challenger's wallet.
 */
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

  @IsString()
  @IsNotEmpty()
  signedTxXdr: string;
}
