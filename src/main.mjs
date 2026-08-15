import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  downloadFormatLabel,
  normalizeDownloadFormat,
  shouldDownloadFormat,
} from './download-formats.mjs';
import {
  isMp3File,
  isWavFile,
  loadManifest,
  numberedBaseName,
  sanitizeFilename,
  saveManifest,
} from './files.mjs';
import {
  collectWorkspaceSongs,
  dismissCookieBanner,
  discoverWorkspaces,
  downloadCurrentSongAsWav,
  downloadMp3FromUrl,
  isLoginRequired,
  isTargetClosedError,
  readCurrentSongMetadata,
  saveFailureDiagnostics,
} from './suno.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountManifestFilename = 'account-download-history.json';

function printHelp() {
  console.log(`
Suno account backup (WAV + MP3 + lyrics + prompts)

Usage:
  npm start                  Back up every unique song in every Workspace
  npm start -- --format mp3  Download MP3 files only
  npm start -- --format wav  Download WAV files only
  npm start -- --limit 3     Process only the first 3 unique songs
  npm run scan              List unique songs without downloading

Options:
  --format FORMAT           Audio format: mp3, wav, or both (default: both)
  --limit N                 Maximum number of unique songs for this run
  --dry-run                 Scan and print only; do not write download files
  --help                    Show this help
`);
}

function parseArguments(argv) {
  const result = { dryRun: false, limit: 0, format: 'both' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--format') {
      result.format = normalizeDownloadFormat(argv[index + 1]);
      index += 1;
    } else if (argument === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit 뒤에는 1 이상의 정수를 입력하세요.');
      result.limit = value;
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션: ${argument}`);
    }
  }
  return result;
}

function resolveProjectPath(value) {
  return path.resolve(projectDirectory, value);
}

function validateConfig(config) {
  const positiveNumbers = [
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
  for (const key of positiveNumbers) {
    if (!Number.isFinite(config[key]) || config[key] < 1) {
      throw new Error(`config.json의 ${key} 값은 1 이상이어야 합니다.`);
    }
  }
  const url = new URL(config.workspaceDiscoveryUrl);
  if (!/(^|\.)suno\.com$/i.test(url.hostname) || url.pathname !== '/create' || !url.searchParams.get('wid')) {
    throw new Error(`올바른 Suno Workspace URL이 아닙니다: ${config.workspaceDiscoveryUrl}`);
  }
  if (url.searchParams.get('wid') === 'YOUR_WORKSPACE_ID') {
    throw new Error('config.json의 YOUR_WORKSPACE_ID를 본인의 Suno Workspace ID로 바꾸세요.');
  }
  if (typeof config.includeArchivedWorkspaces !== 'boolean') {
    throw new Error('config.json의 includeArchivedWorkspaces 값은 true 또는 false여야 합니다.');
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function launchBrowser(config) {
  try {
    return await chromium.launchPersistentContext(config.browserProfileDirectory, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      downloadsPath: resolveProjectPath('./.playwright-downloads'),
      args: ['--start-maximized'],
    });
  } catch (error) {
    throw new Error(
      'Google Chrome을 시작하지 못했습니다. 실행 중인 전용 자동화 창을 모두 닫고 다시 시도하세요.\n'
      + `원인: ${error.message}`,
    );
  }
}

function configurePage(page, config) {
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  return page;
}

async function recoverBrowserPage(context, config) {
  try {
    const page = await context.newPage();
    return { context, page: configurePage(page, config), relaunched: false };
  } catch {
    await context.close().catch(() => {});
    const replacementContext = await launchBrowser(config);
    const page = replacementContext.pages()[0] ?? await replacementContext.newPage();
    return {
      context: replacementContext,
      page: configurePage(page, config),
      relaunched: true,
    };
  }
}

function assignWorkspaceFolders(workspaces) {
  const used = new Set();
  return workspaces.map((workspace) => {
    const base = sanitizeFilename(workspace.name, 80);
    let folderName = base;
    if (used.has(folderName.toLocaleLowerCase())) folderName = `${base} - ${workspace.id.slice(0, 8)}`;
    used.add(folderName.toLocaleLowerCase());
    return { ...workspace, folderName };
  });
}

function relativeOutputPath(config, absolutePath) {
  return path.relative(config.downloadDirectory, absolutePath).split(path.sep).join('/');
}

function absoluteOutputPath(config, relativePath) {
  const root = path.resolve(config.downloadDirectory);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`다운로드 폴더 밖의 경로는 사용할 수 없습니다: ${relativePath}`);
  }
  return resolved;
}

function ensureArtifactPaths(entry, config) {
  entry.files ||= {};
  if (!entry.outputDirectory && entry.files.wav) {
    entry.outputDirectory = path.dirname(entry.files.wav).split('/').join(path.sep);
  }
  entry.outputDirectory ||= 'Unsorted';
  if (!entry.baseName && entry.files.wav) entry.baseName = path.basename(entry.files.wav, path.extname(entry.files.wav));
  entry.baseName ||= numberedBaseName(entry.index, entry.title, config.numberWidth);

  const directory = entry.outputDirectory.split(path.sep).join('/');
  entry.files.wav ||= path.posix.join(directory, `${entry.baseName}.wav`);
  entry.files.mp3 ||= path.posix.join(directory, `${entry.baseName}.mp3`);
  entry.files.lyrics ||= path.posix.join(directory, `${entry.baseName} - lyrics.txt`);
  entry.files.prompt ||= path.posix.join(directory, `${entry.baseName} - prompt.txt`);
  entry.files.metadata ||= path.posix.join(directory, `${entry.baseName} - metadata.json`);

  return Object.fromEntries(
    Object.entries(entry.files).map(([key, value]) => [key, absoluteOutputPath(config, value)]),
  );
}

async function importLegacyDownloads(config, workspaces, accountManifest) {
  let imported = 0;
  for (const workspace of workspaces) {
    const directory = path.join(config.downloadDirectory, workspace.folderName);
    const legacyPath = path.join(directory, 'download-history.json');
    let legacy;
    try {
      legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`기존 완료 기록을 읽을 수 없습니다: ${legacyPath}\n${error.message}`);
    }
    if (legacy?.version !== 1 || !legacy.songs) continue;

    for (const legacyEntry of Object.values(legacy.songs)) {
      if (!legacyEntry?.id || !legacyEntry.filename) continue;
      const wavPath = path.join(directory, legacyEntry.filename);
      if (!await isWavFile(wavPath)) continue;

      let entry = accountManifest.songs[legacyEntry.id];
      if (!entry) {
        entry = {
          id: legacyEntry.id,
          url: legacyEntry.url || `https://suno.com/song/${legacyEntry.id}`,
          index: Number(legacyEntry.index) || 1,
          title: legacyEntry.title || path.basename(legacyEntry.filename, '.wav'),
          baseName: path.basename(legacyEntry.filename, path.extname(legacyEntry.filename)),
          outputDirectory: workspace.folderName,
          workspaces: [workspace.name],
          files: { wav: relativeOutputPath(config, wavPath) },
          status: 'partial',
          importedAt: new Date().toISOString(),
        };
        accountManifest.songs[legacyEntry.id] = entry;
        imported += 1;
      } else {
        entry.workspaces = [...new Set([...(entry.workspaces ?? []), workspace.name])];
        entry.files ||= {};
        entry.files.wav ||= relativeOutputPath(config, wavPath);
      }
      ensureArtifactPaths(entry, config);
    }
  }
  return imported;
}

function buildNextIndexes(manifest) {
  const indexes = new Map();
  for (const entry of Object.values(manifest.songs)) {
    const current = indexes.get(entry.outputDirectory) ?? 1;
    indexes.set(entry.outputDirectory, Math.max(current, (Number(entry.index) || 0) + 1));
  }
  return indexes;
}

async function atomicWriteText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.part`;
  await writeFile(temporaryPath, content, 'utf8');
  await rm(filePath, { force: true });
  await rename(temporaryPath, filePath);
}

function buildPromptText(metadata) {
  return [
    '[Style Prompt]',
    metadata.stylePrompt || '(Not provided by Suno)',
    '',
    '[Description Prompt]',
    metadata.descriptionPrompt || '(Not provided by Suno)',
    '',
  ].join('\n');
}

function buildLyricsText(metadata) {
  const lyrics = metadata.lyrics?.trim();
  if (lyrics) return `${lyrics}\n`;
  return metadata.instrumental
    ? '(Instrumental track: no lyrics)\n'
    : '(No lyrics were provided by Suno)\n';
}

async function isNonBlankTextFile(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).trim().length > 0;
  } catch {
    return false;
  }
}

async function allArtifactsExist(paths, downloadFormat = 'both') {
  const [wav, mp3, lyrics, prompt, metadata] = await Promise.all([
    isWavFile(paths.wav),
    isMp3File(paths.mp3),
    isNonBlankTextFile(paths.lyrics),
    isNonBlankTextFile(paths.prompt),
    isNonBlankTextFile(paths.metadata),
  ]);
  return (
    (!shouldDownloadFormat(downloadFormat, 'wav') || wav)
    && (!shouldDownloadFormat(downloadFormat, 'mp3') || mp3)
    && lyrics
    && prompt
    && metadata
  );
}

async function processSong(page, config, song, workspace, entry, manifestPath, manifest, downloadFormat) {
  const paths = ensureArtifactPaths(entry, config);
  await mkdir(path.dirname(paths.wav), { recursive: true });
  if (await allArtifactsExist(paths, downloadFormat)) {
    entry.status = 'complete';
    console.log(`  건너뜀(완료): ${entry.baseName}`);
    return { completed: true, skipped: true };
  }

  let lastError;
  for (let attempt = 1; attempt <= config.downloadRetryCount; attempt += 1) {
    try {
      console.log(`  곡 상세 정보 확인${attempt > 1 ? ` (재시도 ${attempt})` : ''}: ${entry.title}`);
      await page.goto(song.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await dismissCookieBanner(page);
      const metadata = await readCurrentSongMetadata(page, song.id, entry.title);
      entry.title = metadata.title || entry.title;
      entry.status = 'partial';

      if (!await isNonBlankTextFile(paths.lyrics)) {
        await atomicWriteText(paths.lyrics, buildLyricsText(metadata));
        console.log('    가사 저장 완료');
      }
      if (!await isNonBlankTextFile(paths.prompt)) {
        await atomicWriteText(paths.prompt, buildPromptText(metadata));
        console.log('    프롬프트/스타일 저장 완료');
      }
      if (!await isNonBlankTextFile(paths.metadata)) {
        const metadataFile = {
          id: song.id,
          title: metadata.title,
          sunoUrl: song.url,
          workspaces: entry.workspaces,
          backedUpAt: new Date().toISOString(),
          audioUrl: metadata.audioUrl,
          imageUrl: metadata.imageUrl,
          imageLargeUrl: metadata.imageLargeUrl,
          createdAt: metadata.createdAt,
          modelName: metadata.modelName,
          modelVersion: metadata.modelVersion,
          durationSeconds: metadata.durationSeconds,
          instrumental: metadata.instrumental,
          stylePrompt: metadata.stylePrompt,
          descriptionPrompt: metadata.descriptionPrompt,
          sourceMetadata: metadata.sourceMetadata,
        };
        await atomicWriteText(paths.metadata, `${JSON.stringify(metadataFile, null, 2)}\n`);
        console.log('    메타데이터 저장 완료');
      }
      await saveManifest(manifestPath, manifest);

      if (shouldDownloadFormat(downloadFormat, 'mp3') && !await isMp3File(paths.mp3)) {
        console.log('    MP3 다운로드 중...');
        await downloadMp3FromUrl(page.request, metadata.audioUrl, paths.mp3, config.downloadTimeoutMs);
        if (!await isMp3File(paths.mp3)) throw new Error('MP3 파일 검증에 실패했습니다.');
        await saveManifest(manifestPath, manifest);
        console.log('    MP3 다운로드 완료');
      }

      if (shouldDownloadFormat(downloadFormat, 'wav') && !await isWavFile(paths.wav)) {
        console.log('    WAV 다운로드 중...');
        await rm(paths.wav, { force: true });
        await downloadCurrentSongAsWav(page, paths.wav, config.downloadTimeoutMs);
        if (!await isWavFile(paths.wav)) throw new Error('WAV 파일 검증에 실패했습니다.');
        await saveManifest(manifestPath, manifest);
        console.log('    WAV 다운로드 완료');
      }

      if (!await allArtifactsExist(paths, downloadFormat)) throw new Error('일부 백업 파일이 누락되었습니다.');
      entry.status = 'complete';
      entry.completedAt = new Date().toISOString();
      delete entry.error;
      delete entry.failedAt;
      await saveManifest(manifestPath, manifest);
      console.log(`  완료: ${entry.baseName}`);
      return { completed: true, skipped: false };
    } catch (error) {
      if (isTargetClosedError(error)) {
        entry.status = 'partial';
        entry.error = '전용 Chrome 페이지가 닫혀 자동 복구를 기다리는 중입니다.';
        await saveManifest(manifestPath, manifest);
        throw error;
      }
      lastError = error;
      console.error(`    실패: ${error.message}`);
      await page.keyboard.press('Escape').catch(() => {});
      if (attempt < config.downloadRetryCount) await sleep(2000);
    }
  }

  entry.status = 'error';
  entry.error = lastError?.message ?? '알 수 없는 오류';
  entry.failedAt = new Date().toISOString();
  const diagnosticBase = await saveFailureDiagnostics(page, config.logDirectory, song.id);
  entry.diagnostics = `${relativeOutputPath(config, diagnosticBase)}.png`;
  await saveManifest(manifestPath, manifest);
  console.error(`  이 곡은 기록 후 다음 곡으로 진행합니다. 진단: ${diagnosticBase}.png`);
  return { completed: false, skipped: false };
}

async function processWorkspace(
  initialPage,
  config,
  workspace,
  arguments_,
  state,
  manifestPath,
  manifest,
  nextIndexes,
  isInterrupted,
  recoverPage,
  isRecoveryAttempt = false,
) {
  let page = initialPage;
  console.log(`\n[Workspace: ${workspace.name}${workspace.archived ? ' / 보관됨' : ''}] 곡 목록 수집 중...`);
  await page.goto(workspace.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await dismissCookieBanner(page);
  if (await isLoginRequired(page)) throw new Error('전용 Chrome 프로필의 Suno 로그인이 풀렸습니다.');

  const remaining = arguments_.limit > 0 ? arguments_.limit - state.uniqueSongIds.size : 0;
  const collectionConfig = {
    ...config,
    limit: isRecoveryAttempt ? 0 : (remaining > 0 ? remaining : 0),
  };
  let lastReportedCount = -1;
  const songs = await collectWorkspaceSongs(page, collectionConfig, ({ count, pageNumber }) => {
    if (count !== lastReportedCount) {
      process.stdout.write(`\r  페이지 ${pageNumber}, 수집 ${count}곡`);
      lastReportedCount = count;
    }
  });
  process.stdout.write('\n');

  if (!songs.length) {
    if (workspace.songCount > 0) console.warn(`  화면에서 곡을 찾지 못했습니다. 예상 곡 수: ${workspace.songCount}`);
    return;
  }

  for (const song of songs) {
    if (isInterrupted()) return;
    const referenceKey = `${workspace.id}:${song.id}`;
    const isNewReference = !state.workspaceSongReferences.has(referenceKey);
    if (isNewReference) {
      state.workspaceSongReferences.add(referenceKey);
      state.songReferences += 1;
    }

    if (state.uniqueSongIds.has(song.id)) {
      if (isNewReference) state.duplicateReferences += 1;
      const duplicateEntry = manifest?.songs[song.id];
      if (duplicateEntry) duplicateEntry.workspaces ||= [];
      if (duplicateEntry && !duplicateEntry.workspaces.includes(workspace.name)) {
        duplicateEntry.workspaces.push(workspace.name);
        if (!arguments_.dryRun) await saveManifest(manifestPath, manifest);
      }
      continue;
    }

    state.uniqueSongIds.add(song.id);
    const ordinal = state.uniqueSongIds.size;
    if (arguments_.dryRun) {
      console.log(`${String(ordinal).padStart(config.numberWidth, '0')}  ${song.title}  [${workspace.name}]  ${song.url}`);
    } else {
      let entry = manifest.songs[song.id];
      if (!entry) {
        const nextIndex = nextIndexes.get(workspace.folderName) ?? 1;
        nextIndexes.set(workspace.folderName, nextIndex + 1);
        entry = {
          id: song.id,
          url: song.url,
          index: nextIndex,
          title: song.title,
          baseName: numberedBaseName(nextIndex, song.title, config.numberWidth),
          outputDirectory: workspace.folderName,
          workspaces: [workspace.name],
          files: {},
          status: 'pending',
          discoveredAt: new Date().toISOString(),
        };
        manifest.songs[song.id] = entry;
      } else {
        entry.workspaces ||= [];
        if (!entry.workspaces.includes(workspace.name)) entry.workspaces.push(workspace.name);
      }
      ensureArtifactPaths(entry, config);
      await saveManifest(manifestPath, manifest);

      console.log(`[${ordinal}${arguments_.limit ? `/${arguments_.limit}` : ''}] ${song.title}`);
      let result;
      let songRecoveryAttempts = 0;
      while (!result) {
        try {
          result = await processSong(
            page,
            config,
            song,
            workspace,
            entry,
            manifestPath,
            manifest,
            arguments_.format,
          );
        } catch (error) {
          if (!isTargetClosedError(error)) throw error;
          songRecoveryAttempts += 1;
          if (songRecoveryAttempts > config.browserRestartCount) {
            throw new Error(
              `전용 Chrome 복구가 ${config.browserRestartCount}회 연속 실패했습니다. `
              + '현재 곡은 다음 실행에서 이어받습니다.',
            );
          }
          console.warn(
            `  전용 Chrome 페이지가 닫혔습니다. 자동 복구 ${songRecoveryAttempts}/${config.browserRestartCount}...`,
          );
          const recovered = await recoverPage();
          page = recovered.page;
          state.browserRecoveries += 1;
          console.log(
            recovered.relaunched
              ? '  Chrome을 다시 열었습니다. 현재 곡부터 재개합니다.'
              : '  새 탭을 열었습니다. 현재 곡부터 재개합니다.',
          );
        }
      }
      if (result.completed) state.completed += 1;
      if (result.skipped) state.skipped += 1;
      if (!result.completed) state.errors += 1;
      if (!result.skipped && !isInterrupted()) await sleep(config.delayBetweenDownloadsMs);
    }

    if (arguments_.limit > 0 && state.uniqueSongIds.size >= arguments_.limit) return;
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    printHelp();
    return;
  }

  const configPath = path.join(projectDirectory, 'config.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'config.json이 없습니다. config.example.json을 config.json으로 복사하고 '
        + '본인의 Suno Workspace 주소를 입력하세요.',
      );
    }
    throw error;
  }
  config.downloadDirectory = resolveProjectPath(config.downloadDirectory);
  config.browserProfileDirectory = resolveProjectPath(config.browserProfileDirectory);
  config.logDirectory = resolveProjectPath(config.logDirectory);
  validateConfig(config);

  console.log(`다운로드 형식: ${downloadFormatLabel(arguments_.format)}`);

  await mkdir(config.downloadDirectory, { recursive: true });
  await mkdir(config.browserProfileDirectory, { recursive: true });
  await mkdir(config.logDirectory, { recursive: true });

  console.log('Suno 전용 Chrome을 여는 중...');
  let context = await launchBrowser(config);
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    console.log('\n현재 파일 처리가 끝나면 안전하게 종료합니다...');
  });

  try {
    let page = configurePage(context.pages()[0] ?? await context.newPage(), config);

    console.log('계정의 활성/보관 Workspace를 자동으로 찾는 중...');
    const discovered = await discoverWorkspaces(page, config, ({ workspace, current, total, phase }) => {
      const label = phase === 'archived' ? '보관' : '활성';
      console.log(`  ${label} ${current}/${total}: ${workspace.name} (${workspace.songCount}곡)`);
    });
    if (!discovered.length) {
      await rm(path.join(config.browserProfileDirectory, '.manual-login-complete'), { force: true });
      throw new Error(
        '로그인된 Suno Workspace를 찾지 못했습니다. Suno_로그인_준비.cmd를 실행해 로그인한 뒤 다시 시도하세요.',
      );
    }

    const workspaces = assignWorkspaceFolders(discovered).filter((workspace) => workspace.songCount > 0);
    console.log(`총 ${workspaces.length}개 Workspace를 찾았습니다. 같은 곡 ID는 전체에서 한 번만 저장합니다.`);

    const manifestPath = path.join(config.downloadDirectory, accountManifestFilename);
    const manifest = arguments_.dryRun ? null : await loadManifest(manifestPath, 2);
    if (manifest) {
      const imported = await importLegacyDownloads(config, workspaces, manifest);
      if (imported) console.log(`기존 WAV 완료 기록 ${imported}곡을 새 통합 기록으로 승계했습니다.`);
      await saveManifest(manifestPath, manifest);
    }

    const state = {
      uniqueSongIds: new Set(),
      workspaceSongReferences: new Set(),
      songReferences: 0,
      duplicateReferences: 0,
      browserRecoveries: 0,
      completed: 0,
      skipped: 0,
      errors: 0,
    };
    const nextIndexes = manifest ? buildNextIndexes(manifest) : new Map();

    for (const workspace of workspaces) {
      if (interrupted || (arguments_.limit > 0 && state.uniqueSongIds.size >= arguments_.limit)) break;
      let recoveryAttempts = 0;
      while (!interrupted) {
        try {
          await processWorkspace(
            page,
            config,
            workspace,
            arguments_,
            state,
            manifestPath,
            manifest,
            nextIndexes,
            () => interrupted,
            async () => {
              const recovered = await recoverBrowserPage(context, config);
              context = recovered.context;
              page = recovered.page;
              return recovered;
            },
            recoveryAttempts > 0,
          );
          break;
        } catch (error) {
          if (!isTargetClosedError(error)) {
            state.errors += 1;
            console.error(`  Workspace 처리 실패: ${error.message}`);
            break;
          }

          recoveryAttempts += 1;
          if (recoveryAttempts > config.browserRestartCount) {
            throw new Error(
              `전용 Chrome 복구가 ${config.browserRestartCount}회 연속 실패했습니다. `
              + '현재 진행 기록은 저장되었으므로 프로그램을 다시 실행하면 이어받습니다.',
            );
          }

          console.warn(
            `  전용 Chrome 페이지가 닫혔습니다. 자동 복구 ${recoveryAttempts}/${config.browserRestartCount}...`,
          );
          const recovered = await recoverBrowserPage(context, config);
          context = recovered.context;
          page = recovered.page;
          state.browserRecoveries += 1;
          console.log(recovered.relaunched ? '  Chrome을 다시 열었습니다. 같은 곡부터 재개합니다.' : '  새 탭을 열었습니다. 같은 곡부터 재개합니다.');
        }
      }
    }

    console.log('\n처리 요약');
    console.log(`  고유 곡 ID: ${state.uniqueSongIds.size}`);
    console.log(`  Workspace 간 중복 참조: ${state.duplicateReferences}`);
    if (arguments_.dryRun) {
      console.log('  목록 확인만 완료했습니다. 파일은 내려받지 않았습니다.');
    } else {
      console.log(`  완료/확인: ${state.completed}곡 (기존 완료 ${state.skipped}곡 포함)`);
      console.log(`  Chrome 자동 복구: ${state.browserRecoveries}회`);
      console.log(`  오류: ${state.errors}건`);
      console.log(`  저장 위치: ${config.downloadDirectory}`);
      console.log(`  통합 기록: ${manifestPath}`);
      if (state.errors > 0) process.exitCode = 2;
    }
    if (interrupted) console.log('사용자 요청으로 안전하게 중단했습니다. 같은 명령을 다시 실행하면 이어받습니다.');
  } finally {
    await context?.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\n오류: ${error.message}`);
  process.exitCode = 1;
});
