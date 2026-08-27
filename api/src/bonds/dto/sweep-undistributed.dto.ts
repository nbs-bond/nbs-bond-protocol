import { IsOptional, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

export class SweepUndistributedDto {
  /**
   * Wallet that receives the swept dust as AccruedCredits.
   *
   * Omitted → credited to the protocol admin (the public key of
   * `ADMIN_SECRET_KEY`). Pass a dedicated treasury address here when dust
   * should not land on the admin wallet; there is no separate TREASURY env
   * default.
   */
  @IsOptional()
  @IsString()
  @IsStellarAddress()
  destination?: string;
}
