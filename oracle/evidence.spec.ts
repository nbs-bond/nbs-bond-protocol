import {
  canonicalJson,
  hashEvidence,
  uploadEvidence,
  ipfsCidV0FromBytes,
  encodeBase58btc,
  decodeBase32Lower,
  cidV1ToCidV0,
  normalizeCidV0,
} from '../ipfs/evidence';
import { MockHttpClient } from './test-helpers';

const FIXTURE = {
  project_id: 'VCS-1234',
  carbon_sequestered: 50000,
};

describe('ipfs evidence hashing', () => {
  it('canonicalJson serializes objects with sorted keys', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('hashEvidence is deterministic for identical payloads', () => {
    const first = hashEvidence(FIXTURE);
    const second = hashEvidence({ ...FIXTURE });
    expect(first.ipfs_evidence_hash).toBe(second.ipfs_evidence_hash);
  });

  it('hashEvidence differs when the payload changes', () => {
    const base = hashEvidence(FIXTURE);
    const changed = hashEvidence({ ...FIXTURE, carbon_sequestered: 1 });
    expect(base.ipfs_evidence_hash).not.toBe(changed.ipfs_evidence_hash);
  });

  it('produces a valid CIDv0 base58btc hash with the Qm prefix', () => {
    const { ipfs_evidence_hash } = hashEvidence(FIXTURE);
    expect(ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  });

  it('encodeBase58btc prefixes leading zero bytes with the zero digit', () => {
    expect(encodeBase58btc(Buffer.from([0x00, 0x00, 0x01]))).toBe('112');
    expect(encodeBase58btc(Buffer.from([0xff]))).toBe('5Q');
  });

  it('matches the canonical IPFS CIDv0 of an empty payload', () => {
    expect(ipfsCidV0FromBytes(Buffer.from('', 'utf8'))).toBe(
      'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n',
    );
  });

  it('decodeBase32Lower decodes unpadded base32 lowercase', () => {
    // 'hello' in RFC 4648 base32 lower, unpadded.
    expect(decodeBase32Lower('nbswy3dp').toString('utf8')).toBe('hello');
  });

  it('converts a CIDv1 base32 form back to the equivalent CIDv0', () => {
    // The dag-pb CIDv1 (0x70) of the FIXTURE canonical JSON; the sha2-256
    // digest is shared, so it must normalise back to the CIDv0 form.
    const cidV1 = 'boajcap7mlmmmz62ng6nwbixteotxcqbxvsb6i5ssza5vmu6hyqcb77ea';
    expect(cidV1ToCidV0(cidV1)).toBe(
      'QmSeBRpktGkGPkww81huEzuCCRmDrersmrFztRV9ukMfSo',
    );
    expect(normalizeCidV0(cidV1)).toBe(
      'QmSeBRpktGkGPkww81huEzuCCRmDrersmrFztRV9ukMfSo',
    );
  });

  it('cidV1ToCidV0 returns null for non-sha2-256 CIDs', () => {
    // raw codec + blake2b-256 multihash (0xb3 0x20): not CIDv0-convertible.
    expect(cidV1ToCidV0('bkwzsaaicamcak')).toBeNull();
    // sha2-256 with a length byte other than 32: not CIDv0-convertible.
    expect(cidV1ToCidV0('bkujbsaicamcak')).toBeNull();
    // Not base32 at all.
    expect(cidV1ToCidV0('QmNotBase32')).toBeNull();
  });

  it('normalizeCidV0 rejects unrecognised CIDs', () => {
    expect(() => normalizeCidV0('not-a-cid')).toThrow('unsupported IPFS CID');
    expect(() => normalizeCidV0('bafy123')).toThrow('unsupported IPFS CID');
  });
});

describe('uploadEvidence', () => {
  const config = {
    apiUrl: 'https://api.pinata.cloud',
    apiKey: 'key',
    secretKey: 'secret',
    gateway: 'https://gateway.pinata.cloud/ipfs/',
  };

  it('pins the payload and returns the evidence hash when Pinata echoes the CIDv0', async () => {
    const computed = hashEvidence(FIXTURE).ipfs_evidence_hash;
    const http = new MockHttpClient([
      { status: 200, data: { IpfsHash: computed, PinSize: 42 } },
    ]);
    const result = await uploadEvidence(FIXTURE, config, http);
    expect(result.hash).toBe(computed);
    expect(result.ipfs_evidence_hash).toBe(computed);
    expect(result.gatewayUrl).toContain(computed);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://api.pinata.cloud/pinning/pinJSONToIPFS');
  });

  it('accepts a CIDv1 response that normalises to the computed CIDv0', async () => {
    const computed = hashEvidence(FIXTURE).ipfs_evidence_hash;
    // dag-pb CIDv1 (base32) of the same canonical JSON — same sha2-256
    // digest, different CID version.
    const cidV1 = 'boajcap7mlmmmz62ng6nwbixteotxcqbxvsb6i5ssza5vmu6hyqcb77ea';
    expect(cidV1ToCidV0(cidV1)).toBe(computed);

    const http = new MockHttpClient([
      { status: 200, data: { IpfsHash: cidV1, PinSize: 42 } },
    ]);
    const result = await uploadEvidence(FIXTURE, config, http);
    expect(result.hash).toBe(cidV1);
    expect(result.ipfs_evidence_hash).toBe(computed);
  });

  it('throws when the returned CID differs from the locally computed hash', async () => {
    // A structurally valid CIDv0 (empty payload) that is NOT the computed
    // hash — simulates a provider returning a different CID than what was
    // hashed locally.
    const otherCid = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n';
    expect(otherCid).not.toBe(hashEvidence(FIXTURE).ipfs_evidence_hash);
    const http = new MockHttpClient([
      { status: 200, data: { IpfsHash: otherCid, PinSize: 42 } },
    ]);
    await expect(uploadEvidence(FIXTURE, config, http)).rejects.toThrow(
      /does not match the locally computed evidence hash/,
    );
  });

  it('throws when the response omits IpfsHash', async () => {
    const http = new MockHttpClient([
      { status: 200, data: { PinSize: 42 } },
    ]);
    await expect(uploadEvidence(FIXTURE, config, http)).rejects.toThrow(
      'did not include an IpfsHash',
    );
  });

  it('throws when pinning credentials are missing', async () => {
    await expect(
      uploadEvidence(FIXTURE, { ...config, apiKey: '', secretKey: '' }),
    ).rejects.toThrow('IPFS_API_KEY');
  });

  it('throws when the pinning provider rejects the upload', async () => {
    const http = new MockHttpClient([
      { status: 401, data: { error: 'unauthorized' } },
    ]);
    await expect(uploadEvidence(FIXTURE, config, http)).rejects.toThrow(
      'IPFS upload failed',
    );
  });

  it('propagates network errors from the upstream provider', async () => {
    const http = new MockHttpClient([new Error('connection refused')]);
    await expect(uploadEvidence(FIXTURE, config, http)).rejects.toThrow(
      'connection refused',
    );
  });
});
