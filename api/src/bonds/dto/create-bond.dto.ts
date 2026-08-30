import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsArray,
  IsEnum,
} from 'class-validator';
import { CreditTypeEnum } from '../interfaces/bond.interface';

export class CreateBondDto {
  @IsString()
  @IsNotEmpty()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  faceValue: string;

  @IsArray()
  @IsString({ each: true })
  couponSchedule: string[];

  @IsEnum(CreditTypeEnum)
  creditType: CreditTypeEnum;

  @IsNumber()
  @IsPositive()
  maturityDate: number;

  @IsString()
  @IsNotEmpty()
  totalSupply: string;
}
