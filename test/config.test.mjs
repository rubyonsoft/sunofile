import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDefaultConfig,
  normalizeConfig,
  readOrCreateConfig,
  saveConfigChanges,
} from '../electron/config.mjs';

test('데스크톱 설정을 안전하게 병합한다', () => {
  const defaults = createDefaultConfig('/tmp/data', '/tmp/music');
  const next = normalizeConfig(defaults, {
    downloadDirectory: path.resolve('/tmp/output'),
    downloadRetryCount: 4,
  });
  assert.equal(next.downloadRetryCount, 4);
  assert.equal(next.scanWaitMs, defaults.scanWaitMs);
  assert.equal(next.fastSkipByAudioFileCount, false);
  assert.equal('workspaceDiscoveryUrl' in next, false);
  assert.throws(() => normalizeConfig(defaults, { downloadRetryCount: 0 }), /1 이상의 정수/);
});

test('Workspace 파일 개수 빠른 건너뛰기 설정을 저장한다', () => {
  const defaults = createDefaultConfig('/tmp/data', '/tmp/music');
  const next = normalizeConfig(defaults, { fastSkipByAudioFileCount: true });
  assert.equal(next.fastSkipByAudioFileCount, true);
});

test('이전 설치본 설정을 새 기본값으로 보완해 다시 저장한다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'suno-config-migration-'));
  const filePath = path.join(directory, 'config.json');
  try {
    const defaults = createDefaultConfig(directory, path.join(directory, 'music'));
    const saved = { ...defaults, workspaceDiscoveryUrl: 'https://suno.com/old' };
    delete saved.fastSkipByAudioFileCount;
    await writeFile(filePath, JSON.stringify(saved), 'utf8');

    const loaded = await readOrCreateConfig(filePath, defaults);
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(loaded.fastSkipByAudioFileCount, false);
    assert.equal(persisted.fastSkipByAudioFileCount, false);
    assert.equal('workspaceDiscoveryUrl' in persisted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('작업 시작 전 화면 설정을 설정 파일에 반영한다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'suno-config-start-'));
  const filePath = path.join(directory, 'config.json');
  try {
    const defaults = createDefaultConfig(directory, path.join(directory, 'old'));
    const next = await saveConfigChanges(filePath, defaults, {
      downloadDirectory: path.join(directory, 'new'),
      fastSkipByAudioFileCount: true,
    });
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(next.downloadDirectory, path.join(directory, 'new'));
    assert.equal(persisted.downloadDirectory, path.join(directory, 'new'));
    assert.equal(persisted.fastSkipByAudioFileCount, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
