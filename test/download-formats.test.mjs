import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downloadFormatLabel,
  normalizeDownloadFormat,
  shouldDownloadFormat,
} from '../src/download-formats.mjs';

test('다운로드 형식 옵션을 검증한다', () => {
  assert.equal(normalizeDownloadFormat('both'), 'both');
  assert.equal(normalizeDownloadFormat('MP3'), 'mp3');
  assert.equal(normalizeDownloadFormat('wav'), 'wav');
  assert.throws(() => normalizeDownloadFormat(), /mp3, wav 또는 both/);
  assert.throws(() => normalizeDownloadFormat('flac'), /mp3, wav 또는 both/);
});

test('선택한 오디오 형식만 다운로드 대상으로 분류한다', () => {
  assert.equal(shouldDownloadFormat('mp3', 'mp3'), true);
  assert.equal(shouldDownloadFormat('mp3', 'wav'), false);
  assert.equal(shouldDownloadFormat('wav', 'mp3'), false);
  assert.equal(shouldDownloadFormat('wav', 'wav'), true);
  assert.equal(shouldDownloadFormat('both', 'mp3'), true);
  assert.equal(shouldDownloadFormat('both', 'wav'), true);
  assert.equal(downloadFormatLabel('both'), 'MP3 + WAV');
});
