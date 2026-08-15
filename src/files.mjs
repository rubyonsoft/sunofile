import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeFilename(value, maxLength = 120) {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, maxLength)
    .trim()
    .replace(/[. ]+$/g, '');

  if (!cleaned) return 'Untitled';
  return WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function songIdFromUrl(value) {
  try {
    const url = new URL(value, 'https://suno.com');
    if (!/(^|\.)suno\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/\/song\/([a-zA-Z0-9-]+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function numberedBaseName(index, title, width = 3) {
  return `${String(index).padStart(width, '0')} - ${sanitizeFilename(title)}`;
}

export function numberedFilename(index, title, width = 3, extension = 'wav') {
  return `${numberedBaseName(index, title, width)}.${extension.replace(/^\./, '')}`;
}

export async function isNonEmptyFile(filePath) {
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

async function readHeader(filePath, length) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function isWavFile(filePath) {
  const header = await readHeader(filePath, 12);
  return Boolean(
    header
    && header.length === 12
    && header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WAVE',
  );
}

export async function isMp3File(filePath) {
  const header = await readHeader(filePath, 3);
  return Boolean(
    header
    && header.length >= 2
    && (
      header.toString('ascii', 0, 3) === 'ID3'
      || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
    ),
  );
}

export async function loadManifest(filePath, expectedVersion = 1) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (parsed?.version !== expectedVersion || typeof parsed.songs !== 'object' || !parsed.songs) {
      throw new Error('지원하지 않는 형식입니다.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: expectedVersion, updatedAt: null, songs: {} };
    }
    throw new Error(`완료 기록을 읽을 수 없습니다: ${filePath}\n${error.message}`);
  }
}

export async function saveManifest(filePath, manifest) {
  await mkdir(path.dirname(filePath), { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export function nextManifestIndex(manifest) {
  return Object.values(manifest.songs).reduce(
    (maximum, song) => Math.max(maximum, Number(song.index) || 0),
    0,
  ) + 1;
}
