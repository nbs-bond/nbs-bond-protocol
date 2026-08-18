import { createHash, createHmac } from 'crypto';
import { createAxiosHttpClient, HttpClient } from '../oracle/http';

/**
 * Evidence hashing & upload helpers for `ipfs_evidence_hash`.
 *
 * Evidence hashes are content-addressed: the canonical (key-sorted) JSON of
 * the report is hashed with SHA-256 and encoded as an IPFS CIDv0 (`Qm...`)
 * string, so the digest is deterministic, verifiable, and directly fetchable
 * from any IPFS gateway once pinned. No network round-trip is required to
 * produce the hash, which keeps adapters runnable offline against test data.
 */

const ALPHABET_BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** SHA-256 multihash code (0x12) + digest length (0x20). */
const MULTIHASH_SHA2_256 = Buffer.from([0x12, 0x20]);

/** Multibase prefix for CIDv1 base32 (lowercase, unpadded). */
const MULTIBASE_BASE32_LOWER = 'b';

/** Decode a multibase base32-lower (RFC 4648, unpadded) payload. */
export function decodeBase32Lower(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.toLowerCase()) {
    const index = ALPHABET_BASE32.indexOf(char);
    if (index < 0) {
      throw new Error(`invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Convert a CIDv1 to the equivalent CIDv0 when its multihash is
 * sha2-256/32 (the only digest CIDv0 can carry). Returns null when the
 * multihash is not CIDv0-compatible.
 */
export function cidV1ToCidV0(cid: string): string | null {
  if (!cid.startsWith(MULTIBASE_BASE32_LOWER)) return null;
  let payload: Buffer;
  try {
    payload = decodeBase32Lower(cid.slice(1));
  } catch {
    return null;
  }
  // CIDv1 layout: varint codec, then the multihash. Skip the codec varint
  // (1 byte for common codecs, more for multi-byte varints).
  let codecLen = 1;
  while (codecLen < payload.length && (payload[codecLen - 1] & 0x80) !== 0) {
    codecLen += 1;
  }
  const multihash = payload.subarray(codecLen);
  // sha2-256/32 is encoded as code 0x12 + length 0x20; it is the only
  // multihash CIDv0 can represent.
  if (
    multihash.length < 3 ||
    multihash[0] !== MULTIHASH_SHA2_256[0] ||
    multihash[1] !== MULTIHASH_SHA2_256[1]
  ) {
    return null;
  }
  return encodeBase58btc(multihash);
}

/**
 * Normalise a returned IPFS CID to CIDv0 form so it can be compared with a
 * locally computed CIDv0. Accepts CIDv0 (`Qm...`) or multibase base32 CIDv1;
 * throws for anything else.
 */
export function normalizeCidV0(cid: string): string {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return cid;
  }
  const converted = cidV1ToCidV0(cid);
  if (converted) return converted;
  throw new Error(`unsupported IPFS CID: ${cid}`);
}

const GATEWAY = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';

/** Canonical serialization of a JSON payload (keys sorted, compact). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** Base58btc (IPFS multibase) encoding of a byte buffer. */
export function encodeBase58btc(input: Buffer): string {
  let digits = [0];
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

/** IPFS CIDv0 (`Qm...`) for a raw payload, using the sha2-256 multihash. */
export function ipfsCidV0FromBytes(payload: Buffer): string {
  const digest = createHash('sha256').update(payload).digest();
  return encodeBase58btc(Buffer.concat([MULTIHASH_SHA2_256, digest]));
}

/** Hex digest of a payload (used for test fixtures and byte-level checks). */
export function sha256Hex(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

export interface EvidenceResult {
  /** Content-addressed IPFS CIDv0 (`Qm...`) — value for `ipfs_evidence_hash`. */
  ipfs_evidence_hash: string;
  /** Raw canonical JSON that was hashed (the pinnable payload). */
  canonicalJson: string;
}

/**
 * Deterministically hash any report payload into an evidence hash.
 * Deterministic: identical payloads always yield identical hashes.
 */
export function hashEvidence(payload: unknown): EvidenceResult {
  const serialized = canonicalJson(payload);
  const hash = ipfsCidV0FromBytes(Buffer.from(serialized, 'utf8'));
  return { ipfs_evidence_hash: hash, canonicalJson: serialized };
}

/** Sign the canonical evidence JSON with a provider key (HMAC-SHA256 hex). */
export function signEvidence(payload: unknown, secret: string): string {
  const { canonicalJson: serialized } = hashEvidence(payload);
  return createHmac('sha256', secret).update(serialized).digest('hex');
}

export interface IpfsPinConfig {
  apiUrl: string;
  apiKey: string;
  secretKey: string;
  gateway: string;
}

export interface IpfsUploadResult {
  hash: string;
  gatewayUrl: string;
  pinSize: number;
  timestamp: string;
}

function loadPinConfig(): IpfsPinConfig {
  return {
    apiUrl: process.env.IPFS_API_URL || 'https://api.pinata.cloud',
    apiKey: process.env.IPFS_API_KEY || '',
    secretKey: process.env.IPFS_SECRET_KEY || '',
    gateway: process.env.IPFS_GATEWAY || GATEWAY,
  };
}

/**
 * Hash a payload, upload (pin) it to the configured IPFS provider, and return
 * the evidence hash plus gateway URL. Throws if pinning credentials are
 * missing or the provider rejects the upload.
 */
export async function uploadEvidence(
  payload: unknown,
  config: IpfsPinConfig = loadPinConfig(),
  http: HttpClient = createAxiosHttpClient(),
): Promise<IpfsUploadResult & EvidenceResult> {
  if (!config.apiKey || !config.secretKey) {
    throw new Error('IPFS upload requires IPFS_API_KEY and IPFS_SECRET_KEY');
  }
  const evidence = hashEvidence(payload);
  const { status, data } = await http.post(
    `${config.apiUrl}/pinning/pinJSONToIPFS`,
    {
      pinataContent: JSON.parse(evidence.canonicalJson),
      pinataMetadata: { name: `nbs-oracle-${evidence.ipfs_evidence_hash}` },
    },
    {
      headers: {
        pinata_api_key: config.apiKey,
        pinata_secret_api_key: config.secretKey,
      },
    },
  );

  if (status < 200 || status >= 300) {
    throw new Error(`IPFS upload failed with status ${status}`);
  }

  const result = data as { IpfsHash?: string; PinSize?: number };
  const hash = result.IpfsHash;
  if (!hash) {
    throw new Error('IPFS upload response did not include an IpfsHash');
  }

  // Verify the provider pinned exactly what we hashed. The returned CID may
  // be CIDv1 while the local computation is CIDv0, so normalise both to the
  // same version before comparing; a mismatch means the content that got
  // pinned differs from the locally computed evidence hash and must not be
  // stored as `ipfs_evidence_hash`.
  const returnedCid = normalizeCidV0(hash);
  const computedCid = normalizeCidV0(evidence.ipfs_evidence_hash);
  if (returnedCid !== computedCid) {
    throw new Error(
      `IPFS upload returned CID ${hash} which does not match the locally computed evidence hash ${evidence.ipfs_evidence_hash}`,
    );
  }

  return {
    hash,
    gatewayUrl: `${config.gateway}${hash}`,
    pinSize: result.PinSize ?? Buffer.byteLength(evidence.canonicalJson, 'utf8'),
    timestamp: new Date().toISOString(),
    ...evidence,
  };
}
