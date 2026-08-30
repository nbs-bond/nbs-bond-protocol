import {
  IsString, IsNotEmpty, IsNumber, IsPositive, IsOptional,
  IsBoolean, IsObject, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LocationDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  methodology: string;

  @IsString()
  @IsNotEmpty()
  country: string;

  @IsObject()
  @ValidateNested()
  @Type(() => LocationDto)
  location: LocationDto;

  @IsString()
  @IsNotEmpty()
  totalAreaHa: string;

  @IsString()
  @IsNotEmpty()
  carbonSequestrationEstimate: string;

  @IsOptional()
  @IsBoolean()
  blueCarbon?: boolean;

  @IsOptional()
  @IsBoolean()
  biodiversityCorridor?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @IsOptional()
  nonce?: number;
}
