import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultConfig, normalizeConfig } from '../electron/config.mjs';

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
