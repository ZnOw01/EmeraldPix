import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface VersionedFile {
  version?: string;
}

function readVersionedJson(relativePath: string): VersionedFile {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as VersionedFile;
}

describe('version metadata', () => {
  it('keeps package.json and public/manifest.json on the same version', () => {
    const packageJson = readVersionedJson('package.json');
    const manifestJson = readVersionedJson('public/manifest.json');

    expect(manifestJson.version).toBe(packageJson.version);
  });

  it('keeps package-lock.json aligned with package.json', () => {
    const packageJson = readVersionedJson('package.json');
    const packageLockJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8')
    ) as VersionedFile & {
      packages?: {
        '': VersionedFile;
      };
    };

    expect(packageLockJson.version).toBe(packageJson.version);
    expect(packageLockJson.packages?.['']?.version).toBe(packageJson.version);
  });
});
