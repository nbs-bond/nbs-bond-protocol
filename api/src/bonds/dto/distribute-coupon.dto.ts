import { IsNumber, IsPositive, IsOptional, IsInt, Min } from 'class-validator';

export class DistributeCouponDto {
  @IsNumber()
  @IsPositive()
  periodIndex: number;

  @IsNumber()
  @IsPositive()
  reportId: number;

  /**
   * Maximum number of holders processed in a single on-chain transaction.
   * Defaults to 50 — small enough to stay well inside Soroban's per-transaction
   * instruction budget even for complex bond types (Basket).  Increase only
   * after measuring instruction consumption with `soroban contract invoke --cost`.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  batchSize?: number;
}
