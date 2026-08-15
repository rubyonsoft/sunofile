import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectWorkspaceSongs,
  isTargetClosedError,
  mergeWorkspaceCards,
  WORKSPACE_DISCOVERY_URL,
} from '../src/suno.mjs';

test('개인 Workspace ID 없이 계정 Workspace 목록에서 시작한다', () => {
  assert.equal(WORKSPACE_DISCOVERY_URL, 'https://suno.com/me/workspaces');
});

test('스크롤로 추가된 Workspace를 중복 없이 누적한다', () => {
  const firstPage = Array.from({ length: 20 }, (_value, index) => ({
    name: `Workspace ${index + 1}`,
    songCount: index + 1,
    archived: false,
    id: '',
    url: '',
  }));
  const secondPage = [
    ...firstPage,
    ...Array.from({ length: 20 }, (_value, index) => ({
      name: `Workspace ${index + 21}`,
      songCount: index + 21,
      archived: false,
      id: '',
      url: '',
    })),
  ];

  assert.equal(mergeWorkspaceCards(firstPage, secondPage).length, 40);
});

test('곡 목록 끝에서 필터 영역의 Next page 버튼을 누르지 않는다', async () => {
  const linkLocator = {
    count: async () => 1,
    evaluateAll: async () => [{
      href: 'https://suno.com/song/song-1',
      textContent: 'Song 1',
    }].map((link) => ({ url: link.href, title: link.textContent })),
  };
  const scroller = {
    locator: () => linkLocator,
    evaluate: async () => ({ top: 100, maximum: 100 }),
  };
  const candidates = {
    count: async () => 1,
    nth: () => scroller,
  };
  const page = {
    locator: (selector) => {
      if (selector === '.clip-browser-list-scroller:visible') return candidates;
      return { first: () => ({ waitFor: async () => {} }) };
    },
    getByRole: () => {
      throw new Error('필터 영역의 Next page 버튼을 조회하면 안 됩니다.');
    },
    waitForTimeout: async () => {},
  };

  const songs = await collectWorkspaceSongs(page, {
    limit: 0,
    maxScanRounds: 10,
    scanWaitMs: 1,
    stagnantScanRounds: 2,
  });

  assert.equal(songs.length, 1);
  assert.equal(songs[0].id, 'song-1');
});

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
