import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/**
 * Validates that a numeric field value is within the latitude range [-90, 90].
 * Allows null/empty values — combine with Validators.required when the field is mandatory.
 */
export function latitudeValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined || value === '') {
      return null; // defer to required validator
    }
    const num = Number(value);
    if (isNaN(num) || num < -90 || num > 90) {
      return { latitudeRange: { message: 'Latitude must be between -90 and 90', actual: value } };
    }
    return null;
  };
}

/**
 * Validates that a numeric field value is within the longitude range [-180, 180].
 * Allows null/empty values — combine with Validators.required when the field is mandatory.
 */
export function longitudeValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined || value === '') {
      return null; // defer to required validator
    }
    const num = Number(value);
    if (isNaN(num) || num < -180 || num > 180) {
      return { longitudeRange: { message: 'Longitude must be between -180 and 180', actual: value } };
    }
    return null;
  };
}

/** Stellar public key pattern: starts with G, followed by exactly 55 uppercase alphanumeric chars. */
const STELLAR_ADDRESS_PATTERN = /^G[A-Z0-9]{55}$/;

/**
 * Validates that a string control holds a well-formed Stellar public key (G... format, 56 chars).
 * Allows null/empty values — combine with Validators.required when the field is mandatory.
 */
export function stellarAddressValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (!value) {
      return null; // defer to required validator
    }
    if (!STELLAR_ADDRESS_PATTERN.test(value)) {
      return {
        stellarAddress: {
          message: 'Enter a valid Stellar address (G… followed by 55 uppercase letters/digits)',
        },
      };
    }
    return null;
  };
}

/**
 * Pure helper — validates a Stellar address string without an AbstractControl.
 * Useful for template-driven forms (ngModel) where no reactive control is present.
 */
export function isValidStellarAddress(value: string): boolean {
  return STELLAR_ADDRESS_PATTERN.test(value);
}
