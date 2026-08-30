import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

/**
 * Body for the first step of the pre-signed-transaction flow:
 * POST /bonds/:id/claim/prepare. Returns an unsigned transaction XDR for the
 * claimant's wallet to sign.
 */
export class PrepareClaimDto {
  /**
   * Optional. The claim is always made for the address in the authenticated
   * session (the JWT `sub` claim); when supplied this field is only checked
   * against that address so a client cannot claim on behalf of somebody else.
   * A mismatch is rejected with 403, never silently honoured.
   */
  @IsOptional()
  @IsString()
  @IsStellarAddress()
  investorAddress?: string;
}

/**
 * Body for POST /bonds/:id/claim. `signedTxXdr` is the base64 envelope
 * returned by the /prepare step, signed externally by the claimant's wallet.
 */
export class ClaimCreditsDto {
  @IsOptional()
  @IsString()
  @IsStellarAddress()
  investorAddress?: string;

  @IsString()
  @IsNotEmpty()
  signedTxXdr: string;
}
