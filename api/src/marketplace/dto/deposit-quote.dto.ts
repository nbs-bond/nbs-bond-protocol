import { IsEnum, IsNumber, IsPositive, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class DepositQuoteDto {
  @IsEnum(['USDC', 'XLM'])
  asset: 'USDC' | 'XLM';

  @IsString()
  @IsNotEmpty()
  amount: string;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
