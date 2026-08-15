import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { normalizeDownloadFormat } from '../src/download-formats.mjs';
import {
  createDefaultConfig,
  normalizeConfig,
  readOrCreateConfig,
  saveConfig,
} from './config.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let worker = null;
let workerMode = null;
let loginProcess = null;
let pendingQuit = false;
let allowQuit = false;

function dataDirectory() {
  return app.getPath('userData');
}

function configPath() {
  return path.join(dataDirectory(), 'config.json');
}

function defaults() {
  return createDefaultConfig(
    dataDirectory(),
    path.join(app.getPath('music'), 'Suno Backup'),
  );
}

async function loadConfig() {
  return readOrCreateConfig(configPath(), defaults());
}

function sendJobEvent(payload) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('job:event', payload);
}

async function readStats(config) {
  const manifestPath = path.join(config.downloadDirectory, 'account-download-history.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const songs = Object.values(manifest?.songs ?? {});
    const complete = songs.filter((song) => song.status === 'complete').length;
    const errors = songs.filter((song) => song.status === 'error').length;
    return {
      total: songs.length,
      complete,
      errors,
      remaining: Math.max(0, songs.length - complete),
      updatedAt: manifest.updatedAt ?? null,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`Manifest read failed: ${error.message}`);
    return { total: 0, complete: 0, errors: 0, remaining: 0, updatedAt: null };
  }
}

async function currentState() {
  const config = await loadConfig();
  return {
    config,
    configured: true,
    running: Boolean(worker),
    loggingIn: Boolean(loginProcess),
    mode: workerMode,
    stats: await readStats(config),
    version: app.getVersion(),
  };
}

async function firstExisting(paths) {
  for (const candidate of paths.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next known Chrome installation path.
    }
  }
  return null;
}

async function findChrome() {
  if (process.platform === 'win32') {
    return firstExisting([
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }
  if (process.platform === 'darwin') {
    return firstExisting(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  }
  return firstExisting([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
  ]);
}

async function launchLoginWindow() {
  if (worker) throw new Error('백업 또는 스캔을 중지한 뒤 로그인하세요.');
  if (loginProcess) throw new Error('이미 로그인용 Chrome이 열려 있습니다. 해당 창을 먼저 닫으세요.');
  const chrome = await findChrome();
  if (!chrome) throw new Error('Google Chrome을 찾지 못했습니다. Chrome을 설치한 뒤 다시 시도하세요.');
  const config = await loadConfig();
  await mkdir(config.browserProfileDirectory, { recursive: true });

  return new Promise((resolve, reject) => {
    let launchFailed = false;
    const child = spawn(chrome, [
      `--user-data-dir=${config.browserProfileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--new-window',
      'https://suno.com/',
    ], { stdio: 'ignore' });
    loginProcess = child;
    child.once('error', (error) => {
      launchFailed = true;
      loginProcess = null;
      reject(new Error(`Chrome을 열지 못했습니다: ${error.message}`));
    });
    child.once('exit', async () => {
      loginProcess = null;
      if (launchFailed) return;
      await writeFile(path.join(config.browserProfileDirectory, '.manual-login-complete'), 'ready\n', 'utf8').catch(() => {});
      resolve({ success: true });
    });
  });
}

function parseLogLine(line) {
  if (/^\[(?:Workspace:|\d+)/.test(line)) return { phase: 'working', line };
  if (/완료:|건너뜀\(완료\)/.test(line)) return { phase: 'working', line, refreshStats: true };
  if (/처리 요약/.test(line)) return { phase: 'finishing', line };
  if (/오류:|실패:/.test(line)) return { phase: 'error', line };
  return { phase: 'working', line };
}

function connectOutput(stream, level) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk.replace(/\r/g, '\n');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      sendJobEvent({ type: 'log', level, ...parseLogLine(line) });
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) sendJobEvent({ type: 'log', level, ...parseLogLine(buffer) });
  });
}

async function startWorker({ mode = 'backup', limit = 0, format = 'both' } = {}) {
  if (worker) throw new Error('이미 작업이 실행 중입니다.');
  if (loginProcess) throw new Error('로그인용 Chrome을 완전히 닫은 뒤 다시 시작하세요.');
  const config = await loadConfig();
  await mkdir(config.downloadDirectory, { recursive: true });

  const args = [path.join(app.getAppPath(), 'src', 'main.mjs')];
  if (mode === 'scan') args.push('--dry-run');
  const selectedFormat = normalizeDownloadFormat(format);
  args.push('--format', selectedFormat);
  const numericLimit = Number(limit);
  if (Number.isInteger(numericLimit) && numericLimit > 0) args.push('--limit', String(numericLimit));

  workerMode = mode;
  worker = spawn(process.execPath, args, {
    cwd: dataDirectory(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SUNO_DESKTOP: '1',
      SUNO_DATA_DIRECTORY: dataDirectory(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  connectOutput(worker.stdout, 'info');
  connectOutput(worker.stderr, 'error');
  sendJobEvent({ type: 'state', running: true, mode });

  worker.once('error', (error) => {
    sendJobEvent({ type: 'log', level: 'error', phase: 'error', line: `앱 실행 오류: ${error.message}` });
  });
  worker.once('close', async (code, signal) => {
    const finishedMode = workerMode;
    worker = null;
    workerMode = null;
    sendJobEvent({
      type: 'state',
      running: false,
      mode: finishedMode,
      code,
      signal,
      stats: await readStats(config),
    });
    if (pendingQuit) {
      allowQuit = true;
      app.quit();
    }
  });
  return { success: true };
}

function requestWorkerStop() {
  if (!worker) return { success: false, message: '실행 중인 작업이 없습니다.' };
  worker.stdin.write('__SUNO_STOP__\n');
  sendJobEvent({ type: 'state', running: true, stopping: true, mode: workerMode });
  return { success: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f3ef',
    title: 'Suno Backup Studio',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(moduleDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(moduleDirectory, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', async (event) => {
    if (!worker || allowQuit) return;
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '백업이 진행 중입니다',
      message: '현재 파일 처리를 마친 뒤 앱을 종료할까요?',
      detail: '완료 기록은 저장되며 다음 실행에서 이어받을 수 있습니다.',
      buttons: ['계속 실행', '안전하게 중지 후 종료'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) {
      pendingQuit = true;
      requestWorkerStop();
    }
  });
}

ipcMain.handle('app:get-state', () => currentState());
ipcMain.handle('config:save', async (_event, changes) => {
  if (worker) throw new Error('작업 중에는 설정을 변경할 수 없습니다.');
  const current = await loadConfig();
  const next = normalizeConfig(current, changes ?? {});
  await saveConfig(configPath(), next);
  return { config: next, stats: await readStats(next), configured: true };
});
ipcMain.handle('folder:choose', async () => {
  const config = await loadConfig();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '백업 파일을 저장할 폴더 선택',
    defaultPath: config.downloadDirectory,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('folder:open', async () => {
  const config = await loadConfig();
  await mkdir(config.downloadDirectory, { recursive: true });
  const error = await shell.openPath(config.downloadDirectory);
  if (error) throw new Error(error);
  return { success: true };
});
ipcMain.handle('auth:login', () => launchLoginWindow());
ipcMain.handle('job:start', (_event, options) => startWorker(options));
ipcMain.handle('job:stop', () => requestWorkerStop());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !worker) app.quit();
});
