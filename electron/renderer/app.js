const api = window.sunoBackup;
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
let state = null;
let toastTimer = null;

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast${error ? ' error' : ''}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4500);
}

function errorMessage(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `${name}View`));
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
}

function setStats(stats) {
  elements.totalStat.textContent = stats.total.toLocaleString();
  elements.completeStat.textContent = stats.complete.toLocaleString();
  elements.remainingStat.textContent = stats.remaining.toLocaleString();
  elements.errorStat.textContent = stats.errors.toLocaleString();
  const ratio = stats.total ? Math.round((stats.complete / stats.total) * 100) : 0;
  elements.completeRatio.textContent = `완료율 ${ratio}%`;
}

function setRunning(running, options = {}) {
  if (!state) return;
  state.running = running;
  state.mode = options.mode ?? state.mode;
  const stopping = Boolean(options.stopping);
  const busy = running || Boolean(state.loggingIn);
  elements.loginButton.disabled = busy;
  elements.scanButton.disabled = busy;
  elements.backupButton.disabled = busy;
  elements.stopButton.disabled = !running || stopping;
  elements.audioFormat.disabled = busy;
  elements.limitInput.disabled = busy;
  elements.progressBar.classList.toggle('indeterminate', running);
  elements.progressBar.style.width = running ? '' : (options.done ? '100%' : '0');
  elements.livePill.className = `live-pill${running ? ' running' : options.done ? ' done' : ''}`;
  elements.livePill.querySelector('span').textContent = stopping ? '중지 대기' : running ? '진행 중' : options.done ? '완료' : '대기';
  elements.sideStatusDot.className = `status-dot ${busy ? 'running' : 'ready'}`;
  elements.sideStatusText.textContent = stopping ? '안전하게 중지 중' : state.loggingIn ? 'Suno 로그인 중' : running ? (state.mode === 'scan' ? '곡 목록 확인 중' : '백업 진행 중') : '실행 준비 완료';
  elements.jobTitle.textContent = stopping ? '현재 파일 처리를 마치는 중' : running ? (state.mode === 'scan' ? '계정 곡 목록 확인 중' : '음악 백업 진행 중') : options.done ? '작업이 완료되었습니다' : '백업 준비 완료';
  elements.jobDescription.textContent = running ? '전용 Chrome 창을 닫지 마세요. 작업 기록에서 진행 상황을 확인할 수 있습니다.' : '로그인 상태를 확인한 뒤 전체 백업을 시작하세요.';
}

function fillConfig(config) {
  elements.downloadDirectory.value = config.downloadDirectory || '';
  elements.includeArchived.checked = config.includeArchivedWorkspaces;
  elements.delayMs.value = config.delayBetweenDownloadsMs;
  elements.retryCount.value = config.downloadRetryCount;
  elements.restartCount.value = config.browserRestartCount;
}

function addLog(line, level = 'info') {
  elements.logOutput.querySelector('.empty-log')?.remove();
  const row = document.createElement('div');
  row.className = `log-line ${level}`;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const message = document.createElement('span');
  message.textContent = line;
  row.append(time, message);
  elements.logOutput.append(row);
  while (elements.logOutput.children.length > 500) elements.logOutput.firstElementChild.remove();
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

async function refresh() {
  state = await api.getState();
  fillConfig(state.config);
  setStats(state.stats);
  setRunning(state.running, { mode: state.mode });
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const result = await api.saveConfig({
      downloadDirectory: elements.downloadDirectory.value,
      includeArchivedWorkspaces: elements.includeArchived.checked,
      delayBetweenDownloadsMs: Number(elements.delayMs.value),
      downloadRetryCount: Number(elements.retryCount.value),
      browserRestartCount: Number(elements.restartCount.value),
    });
    state.config = result.config;
    setStats(result.stats);
    setRunning(false);
    elements.saveMessage.textContent = '저장했습니다.';
    setTimeout(() => { elements.saveMessage.textContent = ''; }, 2500);
    showToast('설정을 저장했습니다.');
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function startJob(mode) {
  try {
    const limit = Number(elements.limitInput.value) || 0;
    const format = elements.audioFormat.value;
    addLog(mode === 'scan' ? '곡 목록 확인을 시작합니다.' : '전체 백업을 시작합니다.');
    await api.startJob({ mode, limit, format });
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-go-settings]').forEach((button) => button.addEventListener('click', () => showView('settings')));
elements.settingsForm.addEventListener('submit', saveSettings);
elements.browseButton.addEventListener('click', async () => {
  const folder = await api.chooseFolder();
  if (folder) elements.downloadDirectory.value = folder;
});
elements.openFolderButton.addEventListener('click', () => api.openDownloadFolder().catch((error) => showToast(errorMessage(error), true)));
elements.loginButton.addEventListener('click', async () => {
  state.loggingIn = true;
  setRunning(false);
  elements.loginButton.textContent = 'Chrome 창을 닫으면 완료됩니다…';
  try {
    await api.launchLogin();
    showToast('Suno 로그인 준비가 완료되었습니다.');
    addLog('전용 Chrome 프로필의 로그인 준비가 완료되었습니다.');
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    state.loggingIn = false;
    elements.loginButton.textContent = '1. Suno 로그인';
    setRunning(Boolean(state?.running));
  }
});
elements.scanButton.addEventListener('click', () => startJob('scan'));
elements.backupButton.addEventListener('click', () => startJob('backup'));
elements.stopButton.addEventListener('click', async () => {
  const result = await api.stopJob();
  if (result.success) addLog('안전한 중지를 요청했습니다. 현재 파일 처리가 끝나면 멈춥니다.');
});
elements.clearLogButton.addEventListener('click', () => {
  elements.logOutput.innerHTML = '<div class="empty-log"><span>♪</span><p>새 작업 기록이 여기에 표시됩니다.</p></div>';
});

api.onJobEvent((event) => {
  if (event.type === 'log') addLog(event.line, event.level);
  if (event.type === 'state') {
    setRunning(event.running, { mode: event.mode, stopping: event.stopping, done: !event.running });
    if (event.stats) setStats(event.stats);
    if (!event.running) showToast(event.code === 0 ? '작업을 완료했습니다.' : `작업이 종료되었습니다. 종료 코드: ${event.code ?? '-'}`, event.code > 0);
  }
});

refresh().catch((error) => showToast(errorMessage(error), true));
