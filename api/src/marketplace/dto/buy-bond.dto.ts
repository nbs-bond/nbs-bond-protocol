import { IsNumber, IsPositive, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class BuyBondDto {
  @IsNumber()
  @IsPositive()
  orderId: number;

  @IsString()
  @IsNotEmpty()
  amount: string;

  @IsString()
  @IsNotEmpty()
  maxPrice: string;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
