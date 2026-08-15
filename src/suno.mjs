import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { songIdFromUrl } from './files.mjs';

const DOWNLOAD_TEXT = /^(download|다운로드)$/i;
const WAV_TEXT = /^(wav audio|wav|wav 오디오)$/i;
const DOWNLOAD_FILE_TEXT = /^(download file|파일 다운로드)$/i;
const MORE_TEXT = /(more|option|action|ellipsis|더\s*보기|옵션|메뉴|추가)/i;

export function isTargetClosedError(error) {
  return /target (?:page, context or browser|page|context|browser) has been closed|browser has been closed|page has been closed|context has been closed|page crashed/i
    .test(error?.message ?? String(error));
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = Math.min(await locator.count(), 30);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function waitForAction(findAction, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const action = await findAction();
    if (action) return action;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function findDownloadAction(page) {
  return firstVisible([
    page.getByRole('menuitem', { name: DOWNLOAD_TEXT }),
    page.getByRole('button', { name: DOWNLOAD_TEXT }),
    page.getByRole('link', { name: DOWNLOAD_TEXT }),
    page.getByText(DOWNLOAD_TEXT),
  ]);
}

async function findWavAction(page) {
  return firstVisible([
    page.getByRole('menuitem', { name: WAV_TEXT }),
    page.getByRole('button', { name: WAV_TEXT }),
    page.getByRole('link', { name: WAV_TEXT }),
    page.getByText(WAV_TEXT),
  ]);
}

async function rankedMenuButtons(page) {
  const buttons = page.locator('button:visible, [role="button"]:visible');
  const count = Math.min(await buttons.count(), 180);
  const ranked = [];

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const details = await button.evaluate((element) => ({
      aria: element.getAttribute('aria-label') ?? '',
      title: element.getAttribute('title') ?? '',
      testId: element.getAttribute('data-testid') ?? '',
      text: element.textContent?.trim() ?? '',
      popup: element.getAttribute('aria-haspopup') ?? '',
      html: element.innerHTML.slice(0, 500),
    })).catch(() => null);
    if (!details) continue;

    const label = `${details.aria} ${details.title} ${details.testId} ${details.text}`;
    let score = 0;
    if (MORE_TEXT.test(label)) score += 100;
    if (/^(\.\.\.|⋯|•••)$/.test(details.text)) score += 100;
    if (/(ellipsis|dots-horizontal|more-horizontal|kebab)/i.test(details.html)) score += 80;
    if (details.popup.toLowerCase() === 'menu') score += 20;
    if (/(profile|account|avatar|user|프로필|계정)/i.test(label)) score -= 120;
    if (score > 0) ranked.push({ button, score, index });
  }

  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ button }) => button);
}

async function openSongMenu(page) {
  await page.keyboard.press('Escape').catch(() => {});
  for (const button of await rankedMenuButtons(page)) {
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 3000 }).catch(() => {});
    const downloadAction = await waitForAction(() => findDownloadAction(page), 1000);
    if (downloadAction) return downloadAction;
    await page.keyboard.press('Escape').catch(() => {});
  }
  throw new Error('곡의 더보기 메뉴 또는 Download 항목을 찾지 못했습니다.');
}

async function revealWavAction(page, downloadAction) {
  await downloadAction.hover().catch(() => {});
  let wavAction = await waitForAction(() => findWavAction(page), 1800);
  if (wavAction) return wavAction;

  await downloadAction.click().catch(() => {});
  wavAction = await waitForAction(() => findWavAction(page), 3000);
  if (!wavAction) {
    throw new Error('Download 하위 메뉴에서 WAV Audio 항목을 찾지 못했습니다. Suno 구독 상태를 확인하세요.');
  }
  return wavAction;
}

export async function isLoginRequired(page) {
  if (/(login|sign-in|signin|auth)/i.test(page.url())) return true;
  const loginAction = await firstVisible([
    page.getByRole('button', { name: /^(log in|sign in|로그인)$/i }),
    page.getByRole('link', { name: /^(log in|sign in|로그인)$/i }),
  ]);
  return Boolean(loginAction);
}

export async function dismissCookieBanner(page) {
  const rejectAction = await firstVisible([
    page.getByRole('button', { name: /^(reject all|모두 거부)$/i }),
  ]);
  if (rejectAction) await rejectAction.click().catch(() => {});
}

async function readWorkspaceCards(page, archived) {
  return page.locator('div[role="button"]').evaluateAll((elements, isArchived) => {
    const cards = [];
    const seen = new Set();

    for (const element of elements) {
      const countText = [...element.querySelectorAll('span')]
        .map((span) => span.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .find((text) => /^[\d,]+\s+Songs?\b/i.test(text));
      if (!countText) continue;

      const imageAlt = element.querySelector('img')?.getAttribute('alt') ?? '';
      let name = imageAlt.replace(/^Cover image for\s+/i, '').trim();
      if (!name) {
        name = [...element.querySelectorAll('span')]
          .filter((span) => span.children.length === 0)
          .map((span) => span.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .find((text) => text && !/^[\d,]+\s+Songs?\b/i.test(text)) ?? '';
      }

      const count = Number(countText.match(/^[\d,]+/)?.[0].replace(/,/g, ''));
      if (!name || !Number.isFinite(count)) continue;
      const key = `${name}\u0000${count}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ name, songCount: count, archived: isArchived });
    }
    return cards;
  }, archived);
}

async function clickDomButtonByAriaLabel(page, label) {
  return page.locator('button').evaluateAll((buttons, target) => {
    const button = buttons.find((element) => element.getAttribute('aria-label') === target);
    if (!button) return false;
    button.click();
    return true;
  }, label);
}

async function ensureActiveWorkspaceList(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await clickDomButtonByAriaLabel(page, 'View Active')) {
      await page.waitForTimeout(600);
    }
    const cards = await readWorkspaceCards(page, false);
    if (cards.length) return cards;

    const opened = await page.locator('button, [role="button"]').evaluateAll((elements) => {
      const element = elements.find((candidate) => {
        const label = `${candidate.getAttribute('aria-label') ?? ''} ${candidate.textContent ?? ''}`.trim();
        return /^Workspaces$/i.test(label) || /workspace switcher/i.test(label);
      });
      if (!element) return false;
      element.click();
      return true;
    });
    if (opened) await page.waitForTimeout(600);
    else await page.waitForTimeout(300);
  }
  throw new Error('Suno Workspace 선택 목록을 찾지 못했습니다. 페이지 로딩 상태를 확인하세요.');
}

async function selectWorkspaceCard(page, card, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page.locator('div[role="button"]').evaluateAll((elements, target) => {
      const element = elements.find((candidate) => {
        const countText = [...candidate.querySelectorAll('span')]
          .map((span) => span.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .find((text) => /^[\d,]+\s+Songs?\b/i.test(text));
        const imageAlt = candidate.querySelector('img')?.getAttribute('alt') ?? '';
        let name = imageAlt.replace(/^Cover image for\s+/i, '').trim();
        if (!name) {
          name = [...candidate.querySelectorAll('span')]
            .filter((span) => span.children.length === 0)
            .map((span) => span.textContent?.replace(/\s+/g, ' ').trim() ?? '')
            .find((text) => text && !/^[\d,]+\s+Songs?\b/i.test(text)) ?? '';
        }
        const count = Number(countText?.match(/^[\d,]+/)?.[0].replace(/,/g, ''));
        return name === target.name && count === target.songCount;
      });
      if (!element) return false;
      element.click();
      return true;
    }, card);

    if (clicked) {
      await page.waitForTimeout(450);
      const url = new URL(page.url());
      const workspaceId = url.searchParams.get('wid');
      if (url.pathname === '/create' && workspaceId) {
        return { ...card, id: workspaceId, url: url.href };
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Workspace 주소를 확인하지 못했습니다: ${card.name}`);
}

export async function discoverWorkspaces(page, config, onProgress = () => {}) {
  await page.goto(config.workspaceDiscoveryUrl, { waitUntil: 'domcontentloaded' });
  await dismissCookieBanner(page);
  if (await isLoginRequired(page)) return [];

  const activeCards = await ensureActiveWorkspaceList(page, config.workspaceDiscoveryWaitMs);
  const discovered = [];
  for (const [index, card] of activeCards.entries()) {
    const workspace = await selectWorkspaceCard(page, card, config.workspaceDiscoveryWaitMs);
    discovered.push(workspace);
    onProgress({ workspace, current: index + 1, total: activeCards.length, phase: 'active' });
  }

  if (config.includeArchivedWorkspaces) {
    const opened = await clickDomButtonByAriaLabel(page, 'View Archived');
    if (opened) {
      await page.waitForTimeout(700);
      const archivedCards = await readWorkspaceCards(page, true);
      for (const [index, card] of archivedCards.entries()) {
        const workspace = await selectWorkspaceCard(page, card, config.workspaceDiscoveryWaitMs);
        discovered.push(workspace);
        onProgress({ workspace, current: index + 1, total: archivedCards.length, phase: 'archived' });
      }
    }
  }

  const unique = [...new Map(discovered.map((workspace) => [workspace.id, workspace])).values()];
  const launchId = new URL(config.workspaceDiscoveryUrl).searchParams.get('wid');
  return unique.sort((left, right) => Number(right.id === launchId) - Number(left.id === launchId));
}

async function findWorkspaceScroller(page) {
  const candidates = page.locator('.clip-browser-list-scroller:visible');
  await page.locator('.clip-browser-list-scroller:visible a[href*="/song/"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.locator('a[href*="/song/"]').count()) return candidate;
  }
  return null;
}

export async function collectWorkspaceSongs(page, config, onProgress = () => {}) {
  const scroller = await findWorkspaceScroller(page);
  if (!scroller) {
    throw new Error('Workspace 곡 목록 영역을 찾지 못했습니다. Workspace 화면과 필터를 확인하세요.');
  }

  const songs = new Map();
  let stagnantRounds = 0;
  let pageNumber = 1;

  for (let round = 1; round <= config.maxScanRounds; round += 1) {
    const discovered = await scroller.locator('a[href*="/song/"]').evaluateAll((links) => links.map((link) => ({
      url: link.href,
      title: link.textContent || '',
    })));

    const sizeBefore = songs.size;
    for (const song of discovered) {
      const id = songIdFromUrl(song.url);
      if (!id || songs.has(id)) continue;
      songs.set(id, {
        id,
        url: new URL(`/song/${id}`, 'https://suno.com').href,
        title: song.title.replace(/\s+/g, ' ').trim() || `Suno ${id.slice(0, 8)}`,
      });
    }

    onProgress({ count: songs.size, round, pageNumber });
    if (config.limit > 0 && songs.size >= config.limit) break;

    const scrollState = await scroller.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const next = Math.min(maximum, element.scrollTop + Math.max(500, element.clientHeight * 0.8));
      element.scrollTop = next;
      return { top: next, maximum };
    });
    await page.waitForTimeout(config.scanWaitMs);

    if (scrollState.top >= scrollState.maximum && songs.size === sizeBefore) stagnantRounds += 1;
    else stagnantRounds = 0;

    if (stagnantRounds >= config.stagnantScanRounds) {
      const nextPage = await firstVisible([
        page.getByRole('button', { name: /^Next page$/i }),
      ]);
      if (nextPage && await nextPage.isEnabled().catch(() => false)) {
        await nextPage.click();
        await page.waitForTimeout(config.scanWaitMs * 2);
        await scroller.evaluate((element) => { element.scrollTop = 0; });
        pageNumber += 1;
        stagnantRounds = 0;
      } else {
        break;
      }
    }
  }

  const result = [...songs.values()];
  return config.limit > 0 ? result.slice(0, config.limit) : result;
}

export async function readCurrentSongMetadata(page, songId, fallbackTitle = '') {
  const clip = await page.evaluate((id) => {
    for (const script of document.scripts) {
      const text = script.textContent ?? '';
      if (!text.includes(id) || !text.startsWith('self.__next_f.push(')) continue;
      try {
        const outer = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
        const payload = outer[1];
        if (typeof payload !== 'string') continue;
        const colon = payload.indexOf(':');
        if (colon < 0) continue;
        const tree = JSON.parse(payload.slice(colon + 1));
        const seen = new WeakSet();
        let found = null;
        const visit = (value) => {
          if (found || !value || typeof value !== 'object' || seen.has(value)) return;
          seen.add(value);
          if (value.id === id) {
            found = value;
            return;
          }
          for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
        };
        visit(tree);
        if (found) return found;
      } catch {
        // Unrelated Next.js data chunks are not always standalone JSON.
      }
    }
    return null;
  }, songId);

  const rawMetadata = clip?.metadata && typeof clip.metadata === 'object' ? clip.metadata : {};
  const instrumental = Boolean(rawMetadata.make_instrumental);
  const promptValue = typeof rawMetadata.prompt === 'string' ? rawMetadata.prompt.trim() : '';
  const descriptionPrompt = [
    rawMetadata.gpt_description_prompt,
    rawMetadata.description_prompt,
    rawMetadata.user_prompt,
    instrumental ? promptValue : '',
  ].find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';

  const fallback = await page.evaluate(() => ({
    title: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '',
    audioUrl: document.querySelector('audio[src*=".mp3"]')?.getAttribute('src') ?? '',
    lyrics: [...document.querySelectorAll('textarea, p.whitespace-pre-wrap')]
      .map((element) => element.value || element.textContent || '')
      .sort((left, right) => right.length - left.length)[0] ?? '',
  }));

  return {
    id: songId,
    title: clip?.title?.trim() || fallback.title.trim() || fallbackTitle,
    url: `https://suno.com/song/${songId}`,
    audioUrl: clip?.audio_url || fallback.audioUrl,
    imageUrl: clip?.image_url || '',
    imageLargeUrl: clip?.image_large_url || '',
    createdAt: clip?.created_at || null,
    modelName: clip?.model_name || null,
    modelVersion: clip?.major_model_version || null,
    durationSeconds: Number(rawMetadata.duration) || null,
    instrumental,
    lyrics: instrumental ? '' : (promptValue || fallback.lyrics.trim()),
    stylePrompt: typeof rawMetadata.tags === 'string' ? rawMetadata.tags.trim() : '',
    descriptionPrompt,
    sourceMetadata: rawMetadata,
  };
}

export async function downloadCurrentSongAsWav(page, finalPath, timeoutMs) {
  const downloadAction = await openSongMenu(page);
  const wavAction = await revealWavAction(page, downloadAction);
  const deadline = Date.now() + timeoutMs;
  let downloadResult = null;
  page.waitForEvent('download', { timeout: timeoutMs }).then(
    (download) => { downloadResult = { download }; },
    (error) => { downloadResult = { error }; },
  );
  await wavAction.click();

  let clickedDownloadFile = false;
  while (Date.now() < deadline && !downloadResult?.download) {
    if (downloadResult?.error) {
      throw new Error('WAV 다운로드 이벤트 대기 시간이 초과되었습니다.');
    }

    const finalDownloadAction = await firstVisible([
      page.getByRole('button', { name: DOWNLOAD_FILE_TEXT }),
      page.getByRole('link', { name: DOWNLOAD_FILE_TEXT }),
      page.getByText(DOWNLOAD_FILE_TEXT),
    ]);
    if (
      finalDownloadAction
      && !clickedDownloadFile
      && await finalDownloadAction.isEnabled().catch(() => false)
    ) {
      await finalDownloadAction.click({ timeout: 5000 });
      clickedDownloadFile = true;
    }
    if (!downloadResult?.download) await page.waitForTimeout(250);
  }

  if (!downloadResult?.download) {
    const dialogText = await page.locator('[role="dialog"]:visible').last().innerText().catch(() => '');
    const detail = dialogText.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`WAV 다운로드가 시작되지 않았습니다.${detail ? ` Suno 메시지: ${detail}` : ''}`);
  }

  const download = downloadResult.download;
  const failure = await download.failure();
  if (failure) throw new Error(`Suno WAV 다운로드 실패: ${failure}`);

  const suggested = download.suggestedFilename();
  if (path.extname(suggested).toLowerCase() !== '.wav') {
    throw new Error(`WAV 대신 ${path.extname(suggested) || '확장자 없는 파일'}이 내려왔습니다.`);
  }
  await download.saveAs(finalPath);
  return suggested;
}

export async function downloadMp3FromUrl(request, audioUrl, finalPath, timeoutMs) {
  if (!/^https:\/\//i.test(audioUrl)) throw new Error('곡 상세 정보에서 MP3 주소를 찾지 못했습니다.');
  const response = await request.get(audioUrl, { timeout: timeoutMs });
  if (!response.ok()) throw new Error(`MP3 다운로드 HTTP 오류: ${response.status()}`);
  const body = await response.body();
  const isMp3 = body.length >= 3 && (
    body.toString('ascii', 0, 3) === 'ID3'
    || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0)
  );
  if (!isMp3) throw new Error('받은 MP3 파일의 형식이 올바르지 않습니다.');

  await mkdir(path.dirname(finalPath), { recursive: true });
  const temporaryPath = `${finalPath}.part`;
  try {
    await writeFile(temporaryPath, body);
    await rm(finalPath, { force: true });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return body.length;
}

export async function saveFailureDiagnostics(page, logDirectory, songId) {
  await mkdir(logDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(logDirectory, `${stamp}-${songId}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

  const buttons = await page.locator('button:visible, [role="button"]:visible').evaluateAll((elements) => elements.map((element) => ({
    text: element.textContent?.trim() ?? '',
    ariaLabel: element.getAttribute('aria-label'),
    title: element.getAttribute('title'),
    testId: element.getAttribute('data-testid'),
  }))).catch(() => []);
  await writeFile(`${base}.json`, `${JSON.stringify({ url: page.url(), buttons }, null, 2)}\n`, 'utf8').catch(() => {});
  return base;
}
