import { Injectable, Logger } from '@nestjs/common';

export class IpfsTimeoutError extends Error {
  constructor(
    operation: string,
    url: string,
    timeoutMs: number,
  ) {
    super(
      `IPFS ${operation} timed out after ${timeoutMs}ms for URL: ${url}`,
    );
    this.name = 'IpfsTimeoutError';
  }
}

interface IpfsUploadResult {
  hash: string;
  gatewayUrl: string;
  pinSize: number;
  timestamp: string;
}

interface PinataUploadResponse {
  IpfsHash: string;
  PinSize: number;
}

interface LocalIpfsUploadResponse {
  Hash: string;
  Size: string;
}

@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  private config = {
    apiUrl: process.env.IPFS_API_URL || 'https://api.pinata.cloud',
    apiKey: process.env.IPFS_API_KEY || '',
    secretKey: process.env.IPFS_SECRET_KEY || '',
    gateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/',
    localApiUrl: process.env.IPFS_LOCAL_API_URL || 'http://localhost:5001/api/v0',
    requirePinning:
      process.env.NODE_ENV === 'production' ||
      process.env.REQUIRE_IPFS_PINNING === 'true',
    uploadTimeoutMs: Number(process.env.IPFS_UPLOAD_TIMEOUT_MS) || 30_000,
    pinTimeoutMs: Number(process.env.IPFS_PIN_TIMEOUT_MS) || 60_000,
    readTimeoutMs: Number(process.env.IPFS_READ_TIMEOUT_MS) || 10_000,
  };

  private async fetchWithTimeout(
    operation: string,
    url: string,
    timeoutMs: number,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.logger.error(
          `IPFS ${operation} timed out after ${timeoutMs}ms for URL: ${url}`,
        );
        throw new IpfsTimeoutError(operation, url, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadJson(data: Record<string, unknown>): Promise<IpfsUploadResult> {
    const url = `${this.config.apiUrl}/pinning/pinJSONToIPFS`;
    const response = await this.fetchWithTimeout(
      'uploadJson',
      url,
      this.config.uploadTimeoutMs,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: this.config.apiKey,
          pinata_secret_api_key: this.config.secretKey,
        },
        body: JSON.stringify({
          pinataContent: data,
          pinataMetadata: { name: `nbs-${Date.now()}` },
          pinataOptions: { cidVersion: 0 },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`IPFS upload failed: ${response.statusText}`);
    }

    const result = (await response.json()) as PinataUploadResponse;
    return this.buildUploadResult(result.IpfsHash, result.PinSize);
  }

  async uploadFile(buffer: Buffer, filename: string): Promise<IpfsUploadResult> {
    if (!this.hasPinataCredentials()) {
      if (this.config.requirePinning) {
        throw new Error(
          'IPFS pinning requires IPFS_API_KEY and IPFS_SECRET_KEY',
        );
      }

      this.logger.warn(
        'Pinata credentials are not configured; uploading the file to the local IPFS node without remote pinning',
      );
      return this.uploadFileToLocalNode(buffer, filename);
    }

    const formData = this.createFileFormData(buffer, filename);
    formData.append(
      'pinataMetadata',
      JSON.stringify({ name: filename }),
    );
    formData.append('pinataOptions', JSON.stringify({ cidVersion: 0 }));

    const url = `${this.config.apiUrl}/pinning/pinFileToIPFS`;
    const response = await this.fetchWithTimeout(
      'uploadFile',
      url,
      this.config.uploadTimeoutMs,
      {
        method: 'POST',
        headers: {
          pinata_api_key: this.config.apiKey,
          pinata_secret_api_key: this.config.secretKey,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      throw new Error(`IPFS upload failed: ${response.statusText}`);
    }

    const result = (await response.json()) as PinataUploadResponse;
    return this.buildUploadResult(result.IpfsHash, result.PinSize);
  }

  async getContent(hash: string): Promise<Record<string, unknown>> {
    const url = `${this.config.gateway}${hash}`;
    const response = await this.fetchWithTimeout(
      'getContent',
      url,
      this.config.readTimeoutMs,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch IPFS content: ${response.statusText}`);
    }
    return response.json();
  }

  async pin(hash: string): Promise<void> {
    const url = `${this.config.apiUrl}/pinning/pinByHash`;
    const response = await this.fetchWithTimeout(
      'pin',
      url,
      this.config.pinTimeoutMs,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: this.config.apiKey,
          pinata_secret_api_key: this.config.secretKey,
        },
        body: JSON.stringify({ hashToPin: hash }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to pin hash: ${response.statusText}`);
    }
  }

  private async uploadFileToLocalNode(
    buffer: Buffer,
    filename: string,
  ): Promise<IpfsUploadResult> {
    const url = `${this.config.localApiUrl}/add?cid-version=0&pin=true`;
    const response = await this.fetchWithTimeout(
      'uploadFileToLocalNode',
      url,
      this.config.uploadTimeoutMs,
      {
        method: 'POST',
        body: this.createFileFormData(buffer, filename),
      },
    );

    if (!response.ok) {
      throw new Error(`Local IPFS upload failed: ${response.statusText}`);
    }

    const result = (await response.json()) as LocalIpfsUploadResponse;
    return this.buildUploadResult(result.Hash, Number(result.Size));
  }

  private createFileFormData(buffer: Buffer, filename: string): FormData {
    const formData = new FormData();
    formData.append('file', new Blob([Uint8Array.from(buffer)]), filename);
    return formData;
  }

  private hasPinataCredentials(): boolean {
    return Boolean(this.config.apiKey && this.config.secretKey);
  }

  private buildUploadResult(hash: string, pinSize: number): IpfsUploadResult {
    if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(hash)) {
      throw new Error('IPFS upload returned an invalid CIDv0 hash');
    }

    return {
      hash,
      gatewayUrl: `${this.config.gateway}${hash}`,
      pinSize,
      timestamp: new Date().toISOString(),
    };
  }
}
