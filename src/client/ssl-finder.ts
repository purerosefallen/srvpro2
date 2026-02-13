import { Context } from '../app';
import { TlsOptions } from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  KeyObject,
} from 'node:crypto';

type LoadedCandidate = {
  certPath: string;
  keyPath: string;
  certBuf: Buffer;
  keyBuf: Buffer;
  validToMs: number;
};

export class SSLFinder {
  constructor(private ctx: Context) {}
  private sslPath = this.ctx.getConfig('SSL_PATH', './ssl');
  private sslKey = this.ctx.getConfig('SSL_KEY', '');
  private sslCert = this.ctx.getConfig('SSL_CERT', '');

  private logger = this.ctx.createLogger('SSLFinder');

  private noSSL() {
    if (this.sslPath || this.sslKey || this.sslCert) {
      throw new Error(
        `SSL configuration provided but no valid cert/key found. SSL_PATH=${this.sslPath}, SSL_KEY=${this.sslKey}, SSL_CERT=${this.sslCert}`,
      );
    }
    return undefined;
  }

  findSSL(): TlsOptions | undefined {
    // 1) 优先 SSL_CERT + SSL_KEY
    const explicit = this.tryExplicit(this.sslCert, this.sslKey);
    if (explicit) return { cert: explicit.certBuf, key: explicit.keyBuf };

    // 2) 其次 sslPath：递归找 fullchain.pem + 同目录 privkey.pem，排除过期/不匹配；选有效期最长
    const best = this.findBestFromPath(this.sslPath);
    if (!best) return this.noSSL();

    return { cert: best.certBuf, key: best.keyBuf };
  }

  private tryExplicit(
    certValue: string,
    keyValue: string,
  ): LoadedCandidate | undefined {
    if (!certValue || !keyValue) return undefined;

    const certPath = path.resolve(certValue);
    const keyPath = path.resolve(keyValue);

    const certBuf = this.readFileBuffer(certPath);
    if (!certBuf) {
      this.logger.warn(
        { certPath },
        'SSL_CERT file not found or unreadable; falling back to SSL_PATH search',
      );
      return undefined;
    }

    const parsed = this.parseLeafCertFromBuffer(certBuf);
    if (!parsed) {
      this.logger.warn(
        { certPath },
        'SSL_CERT does not contain a readable leaf certificate; falling back',
      );
      return undefined;
    }

    const now = Date.now();
    if (now >= parsed.validToMs) {
      this.logger.warn(
        { certPath, validTo: new Date(parsed.validToMs).toISOString() },
        'SSL_CERT is expired; falling back',
      );
      return undefined;
    }

    const keyBuf = this.readFileBuffer(keyPath);
    if (!keyBuf) {
      this.logger.warn(
        { keyPath },
        'SSL_KEY file not found or unreadable; falling back',
      );
      return undefined;
    }

    if (!this.isKeyMatching(parsed.x509, keyBuf, keyPath)) {
      this.logger.warn(
        { certPath, keyPath },
        'SSL_CERT and SSL_KEY do not match; falling back',
      );
      return undefined;
    }

    return { certPath, keyPath, certBuf, keyBuf, validToMs: parsed.validToMs };
  }

  private findBestFromPath(dirValue: string): LoadedCandidate | undefined {
    const baseDir = path.resolve(dirValue);
    if (!this.isDir(baseDir)) return undefined;

    let best: LoadedCandidate | undefined;
    const now = Date.now();

    for (const fullchainPath of this.walkFindByName(baseDir, 'fullchain.pem')) {
      // 先读 cert（一次），不合格就别读 key
      const certBuf = this.readFileBuffer(fullchainPath);
      if (!certBuf) continue;

      const parsed = this.parseLeafCertFromBuffer(certBuf);
      if (!parsed) continue;

      if (now >= parsed.validToMs) {
        this.logger.warn(
          {
            certPath: fullchainPath,
            validTo: new Date(parsed.validToMs).toISOString(),
          },
          'Found fullchain.pem but it is expired; skipping',
        );
        continue;
      }

      const keyPath = path.join(path.dirname(fullchainPath), 'privkey.pem');
      const keyBuf = this.readFileBuffer(keyPath);
      if (!keyBuf) continue;

      if (!this.isKeyMatching(parsed.x509, keyBuf, keyPath)) {
        this.logger.warn(
          { certPath: fullchainPath, keyPath },
          'Found cert/key pair but they do not match; skipping',
        );
        continue;
      }

      const cand: LoadedCandidate = {
        certPath: fullchainPath,
        keyPath,
        certBuf,
        keyBuf,
        validToMs: parsed.validToMs,
      };

      if (!best || cand.validToMs > best.validToMs) best = cand;
    }

    return best;
  }

  private readFileBuffer(p: string): Buffer | undefined {
    try {
      return fs.readFileSync(p);
    } catch {
      return undefined;
    }
  }

  private parseLeafCertFromBuffer(
    certBuf: Buffer,
  ): { x509: X509Certificate; validToMs: number } | undefined {
    // fullchain.pem / cert.pem 里通常第一个 CERT block 是 leaf
    const pem = certBuf.toString('utf8');
    const firstCertPem = this.extractFirstPemCertificate(pem);
    if (!firstCertPem) return undefined;

    try {
      const x509 = new X509Certificate(firstCertPem);
      const validToMs = Date.parse(x509.validTo);
      if (!Number.isFinite(validToMs)) return undefined;
      return { x509, validToMs };
    } catch {
      return undefined;
    }
  }

  private extractFirstPemCertificate(pem: string): string | undefined {
    const m = pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/m,
    );
    return m?.[0];
  }

  private isKeyMatching(
    x509: X509Certificate,
    keyBuf: Buffer,
    keyPathForLog: string,
  ): boolean {
    try {
      // cert 公钥
      const certPub = x509.publicKey;

      // private key -> derive public key
      const priv = createPrivateKey(keyBuf);
      const derivedPub = createPublicKey(priv);

      return this.publicKeysEqual(certPub, derivedPub);
    } catch (err: any) {
      // 这里常见是：私钥被 passphrase 加密 / 格式不对
      this.logger.warn(
        { keyPath: keyPathForLog, err: err?.message ?? String(err) },
        'Failed to parse private key for match check; treating as mismatch',
      );
      return false;
    }
  }

  private publicKeysEqual(a: KeyObject, b: KeyObject): boolean {
    // 统一导出成 spki der 来对比
    const aDer = a.export({ type: 'spki', format: 'der' }) as Buffer;
    const bDer = b.export({ type: 'spki', format: 'der' }) as Buffer;

    if (aDer.length !== bDer.length) return false;
    return timingSafeEqual(aDer, bDer);
  }

  private *walkFindByName(root: string, filename: string): Generator<string> {
    const stack: string[] = [root];

    while (stack.length) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const ent of entries) {
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(p);
        } else if (ent.isFile() && ent.name === filename) {
          yield p;
        }
      }
    }
  }

  private isDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
}
