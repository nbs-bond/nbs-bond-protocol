import { BadRequestException } from '@nestjs/common';
import { xdr } from '@stellar/stellar-sdk';

/**
 * Base58btc alphabet used by IPFS CIDv0 (`Qm...`) strings.
 */
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** sha2-256 multihash prefix: 0x12 (sha2-256) + 0x20 (32-byte digest). */
const SHA2_256_MULTIHASH = Buffer.from([0x12, 0x20]);

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const CIDV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/**
 * Thrown when a value cannot be decoded into the 32 raw bytes a Soroban
 * `BytesN<32>` argument requires.
 *
 * Carries the offending `input` and its `decodedLength` (when a decode was
 * possible) so the encoding mismatch is diagnosable, rather than silently
 * producing a wrong-length array that panics the contract.
 */
export class InvalidProjectIdError extends BadRequestException {
  constructor(
    public readonly input: string,
    public readonly decodedLength: number | null,
  ) {
    const lengthDetail =
      decodedLength === null
        ? 'the value did not decode to any bytes'
        : `the value decoded to ${decodedLength} byte${decodedLength === 1 ? '' : 's'}`;
    super(
      `Invalid project ID "${input}": expected a 64-character hex string, ` +
        `a 46-character IPFS CIDv0, or 32 raw bytes, but ${lengthDetail}.`,
    );
  }
}

function decodeBase58btc(input: string): Buffer {
  // Little-endian byte accumulator (least-significant byte first).
  const bytes: number[] = [0];

  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new InvalidProjectIdError(input, null);
    }

    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }

  // Leading `1` digits in base58 encode leading zero bytes.
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== BASE58_ALPHABET[0]) break;
    leadingZeros += 1;
  }

  const result = Buffer.alloc(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    result[leadingZeros + i] = bytes[bytes.length - 1 - i];
  }
  return result;
}

function decodeBytes32(value: string | Uint8Array): Buffer {
  if (typeof value !== 'string') {
    const buf = Buffer.from(value);
    if (buf.length !== 32) {
      throw new InvalidProjectIdError(
        buf.length === 0 ? '<empty bytes>' : buf.toString('hex'),
        buf.length,
      );
    }
    return buf;
  }

  const input = value.trim();
  const normalized =
    input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input;

  if (HEX_64.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }

  if (CIDV0.test(input)) {
    const decoded = decodeBase58btc(input);
    if (
      decoded.length === 34 &&
      decoded[0] === SHA2_256_MULTIHASH[0] &&
      decoded[1] === SHA2_256_MULTIHASH[1]
    ) {
      // Strip the sha2-256 multihash prefix, leaving the 32-byte digest.
      return decoded.subarray(2);
    }
    throw new InvalidProjectIdError(input, decoded.length);
  }

  // Report the hex-decoded length when the value looks like (wrong-length)
  // hex, so callers can see exactly how many bytes their input produced.
  const decodedHexLength = /^[0-9a-fA-F]*$/.test(normalized)
    ? Buffer.from(normalized, 'hex').length
    : null;
  throw new InvalidProjectIdError(input, decodedHexLength);
}

/**
 * Encode a project ID (or any 32-byte hash) as a Soroban `BytesN<32>` ScVal.
 *
 * Accepts, unambiguously:
 * - a 64-character hex string (optional `0x` prefix),
 * - an IPFS CIDv0 (`Qm...`; its 32-byte sha2-256 digest is used),
 * - 32 raw bytes.
 *
 * Rejects everything else with `InvalidProjectIdError` instead of silently
 * re-interpreting the value. The previous behavior (`Buffer.from(value, 'hex')`
 * plus a fallback `sha256(value)`) produced wrong-length byte arrays and panicked
 * the contract.
 */
export function toBytes32(value: string | Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(decodeBytes32(value));
}
