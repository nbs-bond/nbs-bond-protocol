import { Injectable, Logger } from '@nestjs/common';

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
  };

  async uploadJson(data: Record<string, unknown>): Promise<IpfsUploadResult> {
    const response = await fetch(
      `${this.config.apiUrl}/pinning/pinJSONToIPFS`,
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

    const response = await fetch(
      `${this.config.apiUrl}/pinning/pinFileToIPFS`,
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
    const response = await fetch(`${this.config.gateway}${hash}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch IPFS content: ${response.statusText}`);
    }
    return response.json();
  }

  async pin(hash: string): Promise<void> {
    const response = await fetch(
      `${this.config.apiUrl}/pinning/pinByHash`,
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
    const response = await fetch(
      `${this.config.localApiUrl}/add?cid-version=0&pin=true`,
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
