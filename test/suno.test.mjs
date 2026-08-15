import assert from 'node:assert/strict';
import test from 'node:test';
import { isTargetClosedError } from '../src/suno.mjs';

test('전용 Chrome 종료 오류만 자동 복구 대상으로 분류한다', () => {
  assert.equal(
    isTargetClosedError(new Error('locator.count: Target page, context or browser has been closed')),
    true,
  );
  assert.equal(
    isTargetClosedError(new Error('page.goto: Target page, context or browser has been closed')),
    true,
  );
  assert.equal(isTargetClosedError(new Error('page.goto: Page crashed')), true);
  assert.equal(isTargetClosedError(new Error('WAV 파일 준비 시간이 초과되었습니다.')), false);
});
