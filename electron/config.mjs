import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NUMERIC_KEYS = [
  'delayBetweenDownloadsMs',
  'scanWaitMs',
  'maxScanRounds',
  'stagnantScanRounds',
  'workspaceDiscoveryWaitMs',
  'navigationTimeoutMs',
  'downloadTimeoutMs',
  'downloadRetryCount',
  'browserRestartCount',
  'numberWidth',
];

export function createDefaultConfig(dataDirectory, downloadDirectory) {
  return {
    includeArchivedWorkspaces: true,
    downloadDirectory,
    browserProfileDirectory: path.join(dataDirectory, 'browser-profile'),
    logDirectory: path.join(dataDirectory, 'logs'),
    delayBetweenDownloadsMs: 3500,
    scanWaitMs: 1200,
    maxScanRounds: 250,
    stagnantScanRounds: 6,
    workspaceDiscoveryWaitMs: 20000,
    navigationTimeoutMs: 45000,
    downloadTimeoutMs: 120000,
    downloadRetryCount: 2,
    browserRestartCount: 3,
    numberWidth: 3,
  };
}

export function normalizeConfig(current, changes) {
  const next = { ...current };
  delete next.workspaceDiscoveryUrl;
  if ('includeArchivedWorkspaces' in changes) {
    next.includeArchivedWorkspaces = Boolean(changes.includeArchivedWorkspaces);
  }
  if ('downloadDirectory' in changes) {
    const value = String(changes.downloadDirectory ?? '').trim();
    if (!path.isAbsolute(value)) throw new Error('저장 폴더는 절대 경로여야 합니다.');
    next.downloadDirectory = path.normalize(value);
  }
  for (const key of NUMERIC_KEYS) {
    if (!(key in changes)) continue;
    const value = Number(changes[key]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} 값은 1 이상의 정수여야 합니다.`);
    next[key] = value;
  }
  return next;
}

export async function readOrCreateConfig(filePath, defaults) {
  try {
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    return normalizeConfig(defaults, saved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`설정 파일을 읽을 수 없습니다: ${error.message}`);
    await saveConfig(filePath, defaults);
    return defaults;
  }
}

export async function saveConfig(filePath, config) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}
