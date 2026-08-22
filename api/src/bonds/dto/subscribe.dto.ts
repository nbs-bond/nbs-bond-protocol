import { IsNumber, IsPositive, IsString, IsNotEmpty } from 'class-validator';
import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

/**
 * Body for the first step of the pre-signed-transaction flow:
 * POST /bonds/:id/subscribe/prepare. Returns an unsigned transaction XDR for
 * the investor's wallet to sign; no secret key ever touches the API.
 */
export class PrepareSubscribeDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsStellarAddress()
  investorAddress: string;
}

/**
 * Body for POST /bonds/:id/subscribe. `signedTxXdr` is the base64 envelope
 * returned by the /prepare step, signed externally by the investor's wallet.
 * The API never builds or signs this transaction itself — see
 * ContractService.submitSignedTransaction().
 */
export class SubscribeDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsStellarAddress()
  investorAddress: string;

  @IsString()
  @IsNotEmpty()
  signedTxXdr: string;
}
