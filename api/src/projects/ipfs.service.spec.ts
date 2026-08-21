import { Logger } from '@nestjs/common';
import { IpfsService, IpfsTimeoutError } from './ipfs.service';

const CID_V0 = `Qm${'a'.repeat(44)}`;

function response(
  body: Record<string, unknown>,
  options: { ok?: boolean; statusText?: string } = {},
): Response {
  return {
    ok: options.ok ?? true,
    statusText: options.statusText ?? 'OK',
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('IpfsService uploadFile', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      IPFS_API_URL: 'https://api.pinata.test',
      IPFS_API_KEY: 'api-key',
      IPFS_SECRET_KEY: 'secret-key',
      IPFS_GATEWAY: 'https://gateway.test/ipfs/',
      IPFS_LOCAL_API_URL: 'http://localhost:5001/api/v0',
    };
    delete process.env.REQUIRE_IPFS_PINNING;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uploads the original file directly to Pinata as CIDv0', async () => {
    fetchMock.mockResolvedValue(
      response({ IpfsHash: CID_V0, PinSize: 3 }),
    );
    const service = new IpfsService();

    const result = await service.uploadFile(
      Buffer.from([1, 2, 3]),
      'audit-report.pdf',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.pinata.test/pinning/pinFileToIPFS');
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({
      pinata_api_key: 'api-key',
      pinata_secret_api_key: 'secret-key',
    });

    const body = request?.body as FormData;
    const file = body.get('file') as Blob & { name: string };
    expect(file.name).toBe('audit-report.pdf');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(body.get('pinataMetadata')).toBe(
      JSON.stringify({ name: 'audit-report.pdf' }),
    );
    expect(body.get('pinataOptions')).toBe(
      JSON.stringify({ cidVersion: 0 }),
    );
    expect(result).toMatchObject({
      hash: CID_V0,
      gatewayUrl: `https://gateway.test/ipfs/${CID_V0}`,
      pinSize: 3,
    });
  });

  it('uses the local IPFS node when credentials are absent in development', async () => {
    delete process.env.IPFS_API_KEY;
    delete process.env.IPFS_SECRET_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchMock.mockResolvedValue(response({ Hash: CID_V0, Size: '3' }));
    const service = new IpfsService();

    const result = await service.uploadFile(
      Buffer.from('abc'),
      'prospectus.txt',
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('without remote pinning'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5001/api/v0/add?cid-version=0&pin=true',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.hash).toBe(CID_V0);
    expect(result.pinSize).toBe(3);
  });

  it.each([
    ['production', undefined],
    ['development', 'true'],
  ])(
    'requires Pinata credentials when NODE_ENV is %s and REQUIRE_IPFS_PINNING is %s',
    async (nodeEnv, requirePinning) => {
      process.env.NODE_ENV = nodeEnv;
      delete process.env.IPFS_API_KEY;
      delete process.env.IPFS_SECRET_KEY;
      if (requirePinning) {
        process.env.REQUIRE_IPFS_PINNING = requirePinning;
      }
      const service = new IpfsService();

      await expect(
        service.uploadFile(Buffer.from('document'), 'document.pdf'),
      ).rejects.toThrow(
        'IPFS pinning requires IPFS_API_KEY and IPFS_SECRET_KEY',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('reports a failed Pinata upload', async () => {
    fetchMock.mockResolvedValue(
      response({}, { ok: false, statusText: 'Unauthorized' }),
    );
    const service = new IpfsService();

    await expect(
      service.uploadFile(Buffer.from('document'), 'document.pdf'),
    ).rejects.toThrow('IPFS upload failed: Unauthorized');
  });

  it('rejects a non CIDv0 response so stored document hashes stay consistent', async () => {
    fetchMock.mockResolvedValue(
      response({ IpfsHash: 'bafy-invalid-cid', PinSize: 3 }),
    );
    const service = new IpfsService();

    await expect(
      service.uploadFile(Buffer.from('document'), 'document.pdf'),
    ).rejects.toThrow('IPFS upload returned an invalid CIDv0 hash');
  });
});

describe('IpfsService timeout', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      IPFS_API_URL: 'https://api.pinata.test',
      IPFS_API_KEY: 'api-key',
      IPFS_SECRET_KEY: 'secret-key',
      IPFS_GATEWAY: 'https://gateway.test/ipfs/',
      IPFS_LOCAL_API_URL: 'http://localhost:5001/api/v0',
      IPFS_UPLOAD_TIMEOUT_MS: '50',
      IPFS_PIN_TIMEOUT_MS: '50',
      IPFS_READ_TIMEOUT_MS: '50',
    };
    delete process.env.REQUIRE_IPFS_PINNING;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const hangForever = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
    });

  it('throws IpfsTimeoutError when uploadJson hangs', async () => {
    fetchMock.mockImplementation(hangForever);
    const service = new IpfsService();

    await expect(
      service.uploadJson({ key: 'value' }),
    ).rejects.toThrow(IpfsTimeoutError);
    await expect(
      service.uploadJson({ key: 'value' }),
    ).rejects.toThrow('IPFS uploadJson timed out');
  });

  it('throws IpfsTimeoutError when uploadFile hangs', async () => {
    fetchMock.mockImplementation(hangForever);
    const service = new IpfsService();

    await expect(
      service.uploadFile(Buffer.from('doc'), 'doc.pdf'),
    ).rejects.toThrow(IpfsTimeoutError);
  });

  it('throws IpfsTimeoutError when getContent hangs', async () => {
    fetchMock.mockImplementation(hangForever);
    const service = new IpfsService();

    await expect(service.getContent(CID_V0)).rejects.toThrow(IpfsTimeoutError);
    await expect(service.getContent(CID_V0)).rejects.toThrow(
      'IPFS getContent timed out',
    );
  });

  it('throws IpfsTimeoutError when pin hangs', async () => {
    fetchMock.mockImplementation(hangForever);
    const service = new IpfsService();

    await expect(service.pin(CID_V0)).rejects.toThrow(IpfsTimeoutError);
    await expect(service.pin(CID_V0)).rejects.toThrow('IPFS pin timed out');
  });

  it('logs the operation and URL on timeout', async () => {
    fetchMock.mockImplementation(hangForever);
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const service = new IpfsService();

    await expect(service.pin(CID_V0)).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('IPFS pin timed out'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://api.pinata.test/pinning/pinByHash'),
    );
  });

  it('passes through non-timeout fetch errors', async () => {
    fetchMock.mockRejectedValue(new Error('network failure'));
    const service = new IpfsService();

    try {
      await service.pin(CID_V0);
      fail('expected pin to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('network failure');
      expect(error).not.toBeInstanceOf(IpfsTimeoutError);
    }
  });
});
