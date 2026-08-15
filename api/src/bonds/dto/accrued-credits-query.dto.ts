import { IsStellarAddress } from '../../common/decorators/is-stellar-address.decorator';

export class AccruedCreditsQueryDto {
  @IsStellarAddress()
  holder: string;
}
