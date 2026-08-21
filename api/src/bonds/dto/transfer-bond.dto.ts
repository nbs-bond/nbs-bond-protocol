import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

export class TransferBondDto {
  /**
   * Optional. The sender is always the address in the authenticated session
   * (the JWT `sub` claim); when supplied this field is only checked against
   * that address so a client cannot move somebody else's tokens. A mismatch
   * is rejected with 403, never silently honoured.
   */
  @IsOptional()
  @IsString()
  @IsStellarAddress()
  fromAddress?: string;

  @IsString()
  @IsStellarAddress()
  toAddress: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}
