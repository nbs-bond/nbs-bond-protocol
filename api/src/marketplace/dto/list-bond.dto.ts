import { IsString, IsNumber, IsPositive, IsOptional, IsEnum, Min, Max } from 'class-validator';

export class ListBondDto {
  @IsNumber()
  @IsPositive()
  bondId: number;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsNumber()
  @IsPositive()
  pricePerToken: number;

  @IsString()
  @IsEnum(['USDC', 'XLM'])
  quoteAsset: 'USDC' | 'XLM';

  @IsNumber()
  @Min(1)
  @Max(2592000)
  @IsOptional()
  expiresAfterSeconds?: number = 86400;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
