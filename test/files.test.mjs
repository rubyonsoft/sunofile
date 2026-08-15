import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadManifest,
  isMp3File,
  isWavFile,
  nextManifestIndex,
  numberedBaseName,
  numberedFilename,
  sanitizeFilename,
  saveManifest,
  songIdFromUrl,
} from '../src/files.mjs';

test('Windows에서 사용할 수 없는 파일명 문자를 정리한다', () => {
  assert.equal(sanitizeFilename('  A: song / test?  '), 'A song test');
  assert.equal(sanitizeFilename('...'), 'Untitled');
  assert.equal(sanitizeFilename('CON'), '_CON');
});

test('Suno 곡 주소에서 ID만 추출한다', () => {
  assert.equal(
    songIdFromUrl('https://suno.com/song/e7d772da-2378-40c8-9872-90c2b8205ad7?sh=x'),
    'e7d772da-2378-40c8-9872-90c2b8205ad7',
  );
  assert.equal(songIdFromUrl('/song/abc-123'), 'abc-123');
  assert.equal(songIdFromUrl('https://example.com/song/abc'), null);
});

test('번호가 붙은 WAV 파일명을 만든다', () => {
  assert.equal(numberedFilename(7, 'My: Song', 3), '007 - My Song.wav');
  assert.equal(numberedFilename(7, 'My: Song', 3, 'mp3'), '007 - My Song.mp3');
  assert.equal(numberedBaseName(7, 'My: Song', 3), '007 - My Song');
});

test('WAV와 MP3 파일 헤더를 검증한다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'suno-audio-'));
  const wavPath = path.join(directory, 'valid.wav');
  const mp3Path = path.join(directory, 'valid.mp3');
  const invalidPath = path.join(directory, 'invalid.bin');
  try {
    await writeFile(wavPath, Buffer.from('RIFF0000WAVEdata', 'ascii'));
    await writeFile(mp3Path, Buffer.from([0x49, 0x44, 0x33, 0x04]));
    await writeFile(invalidPath, Buffer.from('not audio', 'ascii'));
    assert.equal(await isWavFile(wavPath), true);
    assert.equal(await isMp3File(mp3Path), true);
    assert.equal(await isWavFile(invalidPath), false);
    assert.equal(await isMp3File(invalidPath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('완료 기록의 다음 번호를 계산한다', () => {
  const manifest = { songs: { a: { index: 2 }, b: { index: 9 } } };
  assert.equal(nextManifestIndex(manifest), 10);
});

test('완료 기록을 반복 저장하고 다시 읽는다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'suno-manifest-'));
  const filePath = path.join(directory, 'download-history.json');
  try {
    const manifest = { version: 1, updatedAt: null, songs: {} };
    await saveManifest(filePath, manifest);
    manifest.songs.abc = { id: 'abc', index: 1, status: 'done' };
    await saveManifest(filePath, manifest);

    const loaded = await loadManifest(filePath);
    assert.equal(loaded.songs.abc.status, 'done');
    assert.match(await readFile(filePath, 'utf8'), /"abc"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
