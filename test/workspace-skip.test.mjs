import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateWorkspaceAudioFiles,
  hasEnoughWorkspaceAudioFiles,
} from '../src/workspace-skip.mjs';

test('선택한 음악 형식별 파일 수가 곡 수 이상일 때만 건너뛴다', () => {
  const counts = { mp3: 12, wav: 9 };
  assert.equal(hasEnoughWorkspaceAudioFiles(10, 'mp3', counts), true);
  assert.equal(hasEnoughWorkspaceAudioFiles(10, 'wav', counts), false);
  assert.equal(hasEnoughWorkspaceAudioFiles(10, 'both', counts), false);
  assert.equal(hasEnoughWorkspaceAudioFiles(0, 'mp3', counts), false);
});

test('Workspace 폴더의 MP3와 WAV 파일만 확장자 구분 없이 센다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'suno-workspace-skip-'));
  try {
    await Promise.all([
      writeFile(path.join(directory, '001.mp3'), ''),
      writeFile(path.join(directory, '002.MP3'), ''),
      writeFile(path.join(directory, '001.wav'), ''),
      writeFile(path.join(directory, 'unfinished.wav.part'), ''),
      mkdir(path.join(directory, 'folder.mp3')),
    ]);

    const mp3 = await evaluateWorkspaceAudioFiles(directory, 2, 'mp3');
    assert.deepEqual(mp3, { skip: true, counts: { mp3: 2, wav: 1 } });

    const both = await evaluateWorkspaceAudioFiles(directory, 2, 'both');
    assert.deepEqual(both, { skip: false, counts: { mp3: 2, wav: 1 } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Workspace 폴더가 없으면 일반 확인으로 진행한다', async () => {
  const directory = path.join(os.tmpdir(), `missing-suno-workspace-${Date.now()}`);
  assert.deepEqual(
    await evaluateWorkspaceAudioFiles(directory, 1, 'both'),
    { skip: false, counts: { mp3: 0, wav: 0 } },
  );
});
