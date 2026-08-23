import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';

export const MINIO_FETCH = 'CV_MINIO_FETCH';
export const MINIO_CONFIG = 'CV_MINIO_CONFIG';

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

const sha256Hex = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/**
 * SigV4 against MinIO, matching the house pattern in catalog-microservice: no SDK
 * dependency, just crypto and fetch.
 */
@Injectable()
export class MinioService {
  private readonly logger = new Logger(MinioService.name);

  constructor(
    @Inject(MINIO_CONFIG) private readonly config: MinioConfig,
    @Optional() @Inject(MINIO_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Stores an object and returns its key. Raises on any non-2xx — never silently drops. */
  async putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    const response = await this.send('PUT', key, body, contentType);

    if (response.status !== 200 && response.status !== 204) {
      const detail = await response.text().catch(() => '<unreadable>');
      this.logger.error(`MinIO PUT ${this.config.bucket}/${key} returned ${response.status}: ${detail.slice(0, 200)}`);
      throw new Error(`failed to store ${key}: MinIO returned ${response.status}`);
    }

    this.logger.log(`stored ${this.config.bucket}/${key} (${body.length} bytes)`);
    return key;
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.send('GET', key, Buffer.alloc(0), 'application/octet-stream');

    if (response.status !== 200) {
      const detail = await response.text().catch(() => '<unreadable>');
      this.logger.error(`MinIO GET ${this.config.bucket}/${key} returned ${response.status}`);
      throw new Error(`failed to read ${key}: MinIO returned ${response.status}: ${detail.slice(0, 200)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async send(method: string, key: string, body: Buffer, contentType: string): Promise<Response> {
    const region = this.config.region ?? 'us-east-1';
    const path = `/${this.config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(path, this.config.endpoint);

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${url.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(`AWS4${this.config.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, 's3');
    const signingKey = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization:
            `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
          'content-type': contentType,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amzDate,
        },
        body: method === 'PUT' ? new Uint8Array(body) : undefined,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`MinIO ${method} ${path} transport failure: ${message}`);
      throw new Error(`MinIO request failed: ${message}`);
    }
  }
}
