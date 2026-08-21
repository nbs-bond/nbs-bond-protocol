import { createHash } from 'crypto';
import { toBytes32, InvalidProjectIdError } from './bytes32';

const ALPHABET_BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MULTIHASH_SHA2_256 = Buffer.from([0x12, 0x20]);

/** Local base58btc encoder used only to round-trip test CIDs. */
function encodeBase58btc(input: Buffer): string {
  const digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of input) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  const out = Array(leadingZeros).fill(ALPHABET_BASE58[0]).join('');
  return out + digits.reverse().map((d) => ALPHABET_BASE58[d]).join('');
}

function cidV0For(payload: Buffer): string {
  const digest = createHash('sha256').update(payload).digest();
  return encodeBase58btc(Buffer.concat([MULTIHASH_SHA2_256, digest]));
}

function bytesOf(value: string | Uint8Array): Buffer {
  return Buffer.from(toBytes32(value).bytes());
}

const EMPTY_SHA256 = createHash('sha256').update('').digest();
// Canonical IPFS CIDv0 of an empty payload.
const EMPTY_CIDV0 = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n';

describe('toBytes32', () => {
  it('decodes a 64-character hex string into 32 raw bytes', () => {
    const hex = 'ab'.repeat(32);
    expect(bytesOf(hex).toString('hex')).toBe(hex);
  });

  it('accepts an 0x-prefixed hex string', () => {
    const hex = 'ab'.repeat(32);
    expect(bytesOf(`0x${hex}`).toString('hex')).toBe(hex);
    expect(bytesOf(`0X${hex}`).toString('hex')).toBe(hex);
  });

  it('decodes an IPFS CIDv0 into its 32-byte sha2-256 digest', () => {
    expect(bytesOf(EMPTY_CIDV0)).toEqual(EMPTY_SHA256);
  });

  it('round-trips a CIDv0 produced from known bytes', () => {
    const payload = Buffer.from('nbs-bond-project', 'utf8');
    const digest = createHash('sha256').update(payload).digest();
    expect(bytesOf(cidV0For(payload))).toEqual(digest);
  });

  it('uses 32 raw bytes as-is', () => {
    const buf = Buffer.alloc(32, 7);
    expect(bytesOf(buf)).toEqual(buf);
  });

  it('rejects a wrong-length hex string with its decoded length', () => {
    try {
      toBytes32('abcd');
      throw new Error('expected InvalidProjectIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProjectIdError);
      expect((error as InvalidProjectIdError).input).toBe('abcd');
      expect((error as InvalidProjectIdError).decodedLength).toBe(2);
      expect((error as InvalidProjectIdError).message).toContain('abcd');
    }
  });

  it('rejects an unrecognized string with no decoded length', () => {
    try {
      toBytes32('VCS-1234');
      throw new Error('expected InvalidProjectIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProjectIdError);
      expect((error as InvalidProjectIdError).decodedLength).toBeNull();
    }
  });

  it('rejects raw bytes whose length is not 32', () => {
    try {
      toBytes32(Buffer.alloc(31, 1));
      throw new Error('expected InvalidProjectIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProjectIdError);
      expect((error as InvalidProjectIdError).decodedLength).toBe(31);
    }
  });

  it('produces a scvBytes ScVal of exactly 32 bytes', () => {
    const scVal = toBytes32('ab'.repeat(32));
    expect(scVal.bytes().length).toBe(32);
  });
});
