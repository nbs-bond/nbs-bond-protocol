import { IsOptional, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

export class ClaimCreditsDto {
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
