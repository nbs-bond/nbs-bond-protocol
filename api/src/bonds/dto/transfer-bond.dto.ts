import { IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

/**
 * Body for the first step of the pre-signed-transaction flow:
 * POST /bonds/:id/transfer/prepare. Returns an unsigned transaction XDR for
 * the sending wallet to sign.
 */
export class PrepareTransferDto {
  @IsString()
  @IsStellarAddress()
  fromAddress: string;

  @IsString()
  @IsStellarAddress()
  toAddress: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}

/**
 * Body for POST /bonds/:id/transfer. `signedTxXdr` is the base64 envelope
 * returned by the /prepare step, signed externally by `fromAddress`'s wallet.
 */
export class TransferBondDto {
  @IsString()
  @IsStellarAddress()
  fromAddress: string;

  @IsString()
  @IsStellarAddress()
  toAddress: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsNotEmpty()
  signedTxXdr: string;
}
