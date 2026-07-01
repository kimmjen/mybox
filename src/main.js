const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI_PLUGIN_DIALOG__;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const linkInput          = document.getElementById('link-input');
const passwordInput      = document.getElementById('password-input');
const filenameInput      = document.getElementById('filename-input');
const folderDisplay      = document.getElementById('folder-display');
const folderPickBtn      = document.getElementById('folder-pick-btn');
const passwordToggle     = document.getElementById('password-toggle');
const addQueueBtn        = document.getElementById('add-queue-btn');
const queueSection       = document.getElementById('queue-section');
const queueListEl        = document.getElementById('queue-list');
const queueCountEl       = document.getElementById('queue-count');
const queueClearBtn      = document.getElementById('queue-clear-btn');
const startQueueBtn      = document.getElementById('start-queue-btn');
const startQueueCountEl  = document.getElementById('start-queue-count');
const progressArea       = document.getElementById('progress-area');
const progressTitle      = document.getElementById('progress-title');
const progressPercent    = document.getElementById('progress-percent');
const progressBarFill    = document.getElementById('progress-bar-fill');
const progressStatus     = document.getElementById('progress-status');
const openPdfButton      = document.getElementById('open-pdf-button');
const terminalConsole    = document.getElementById('terminal-console');

const depModal            = document.getElementById('dep-modal');
const depChecking         = document.getElementById('dep-checking');
const depList             = document.getElementById('dep-list');
const depNeedsInteraction = document.getElementById('dep-needs-interaction');
const depInstallTerminal  = document.getElementById('dep-install-terminal');
const depCancelBtn        = document.getElementById('dep-cancel-btn');
const depRecheckBtn       = document.getElementById('dep-recheck-btn');
const depInstallBtn       = document.getElementById('dep-install-btn');
const depProceedBtn       = document.getElementById('dep-proceed-btn');

// ── State ─────────────────────────────────────────────────────────────────────

let unlistenProgress    = null;
let unlistenDepInstall  = null;
let unlistenDepComplete = null;
let generatedPdfPath    = null;
let pendingAction       = null;
let isProcessing        = false;
let queueIdCounter      = 0;

// queue item: { id, url, password, customFilename, outputFolder, status, pdfPath? }
// status: 'pending' | 'running' | 'done' | 'error'
let queue = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function logTo(container, type, message) {
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setDot(depName, state) {
  const item = document.querySelector(`.dep-status-bar [data-dep="${depName}"] .dot`);
  if (item) item.className = `dot ${state}`;
}

async function refreshStatusBar() {
  try {
    const deps = await invoke('check_dependencies');
    deps.forEach(d => setDot(d.name, d.installed ? 'ok' : 'missing'));
  } catch {
    ['brew','nvm','node','playwright','pyenv','python','pillow'].forEach(n => setDot(n, 'missing'));
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────────

const STATUS_CFG = {
  pending: { icon: '⏳', cls: 'pending', text: '대기' },
  running: { icon: '⟳',  cls: 'running', text: '진행 중' },
  done:    { icon: '✓',  cls: 'done',    text: '완료' },
  error:   { icon: '✗',  cls: 'error',   text: '실패' },
};

function renderQueue() {
  const pendingCount = queue.filter(i => i.status === 'pending').length;
  queueCountEl.textContent      = queue.length;
  startQueueCountEl.textContent = pendingCount;
  startQueueBtn.disabled        = pendingCount === 0 || isProcessing;
  queueSection.style.display    = queue.length > 0 ? 'block' : 'none';

  queueListEl.innerHTML = '';
  queue.forEach(item => {
    const s     = STATUS_CFG[item.status];
    const label = item.customFilename || item.url.slice(-40);
    const el    = document.createElement('div');
    el.className = `queue-item queue-item--${s.cls}`;
    el.innerHTML = `
      <span class="queue-item-icon">${s.icon}</span>
      <span class="queue-item-label" title="${item.url}">${label}</span>
      <span class="queue-item-badge queue-badge--${s.cls}">${s.text}</span>
      ${item.status === 'pending'
        ? `<button class="queue-item-remove" data-id="${item.id}">✕</button>`
        : ''}
    `;
    queueListEl.appendChild(el);
  });

  queueListEl.querySelectorAll('.queue-item-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      queue = queue.filter(i => i.id !== Number(btn.dataset.id));
      renderQueue();
    });
  });
}

function addToQueue() {
  const url      = linkInput.value.trim();
  const password = passwordInput.value.trim();
  if (!url)      { alert('공유 링크를 입력해 주세요!'); return; }
  if (!password) { alert('비밀번호를 입력해 주세요!');  return; }

  queue.push({
    id: ++queueIdCounter,
    url,
    password,
    customFilename: filenameInput.value.trim().replace(/\.pdf$/i, ''),
    outputFolder:   folderDisplay.value.trim(),
    status:         'pending',
  });

  renderQueue();
  linkInput.value    = '';
  filenameInput.value = '';
  linkInput.focus();
}

// ── Dep modal helpers ─────────────────────────────────────────────────────────

function setModalSection(checking, list, warning, terminal, cancel, recheck, install, proceed) {
  depChecking.style.display         = checking ? 'flex'        : 'none';
  depList.style.display             = list     ? 'block'       : 'none';
  depNeedsInteraction.style.display = warning  ? 'block'       : 'none';
  depInstallTerminal.style.display  = terminal ? 'block'       : 'none';
  depCancelBtn.style.display        = cancel   ? 'inline-flex' : 'none';
  depRecheckBtn.style.display       = recheck  ? 'inline-flex' : 'none';
  depInstallBtn.style.display       = install  ? 'inline-flex' : 'none';
  depProceedBtn.style.display       = proceed  ? 'inline-flex' : 'none';
}

function closeModal() {
  depModal.classList.remove('visible');
  if (unlistenDepInstall)  { unlistenDepInstall();  unlistenDepInstall  = null; }
  if (unlistenDepComplete) { unlistenDepComplete(); unlistenDepComplete = null; }
}

// ── Dependency check ──────────────────────────────────────────────────────────

function renderDepList(deps) {
  depList.innerHTML = '';
  deps.forEach(dep => {
    const el = document.createElement('div');
    el.className = 'dep-item';
    el.dataset.step = dep.name;
    el.innerHTML = `
      <span class="dep-icon ${dep.installed ? 'installed' : 'missing'}">${dep.installed ? '✓' : '✗'}</span>
      <span class="dep-name">${dep.label}</span>
      <span class="dep-badge ${dep.installed ? 'installed' : 'missing'}">${dep.installed ? '설치됨' : '미설치'}</span>
    `;
    depList.appendChild(el);
  });
  return deps.filter(d => !d.installed);
}

function updateDepItem(stepName, status) {
  const item = depList.querySelector(`[data-step="${stepName}"]`);
  if (!item) return;
  const icon  = item.querySelector('.dep-icon');
  const badge = item.querySelector('.dep-badge');
  const map = {
    done:              { icon: '✓', iconCls: 'installed', text: '설치됨',    badgeCls: 'installed' },
    skip:              { icon: '✓', iconCls: 'installed', text: '설치됨',    badgeCls: 'installed' },
    running:           { icon: '⟳', iconCls: 'running',   text: '설치 중',   badgeCls: 'running'   },
    error:             { icon: '✗', iconCls: 'missing',   text: '실패',      badgeCls: 'missing'   },
    needs_interaction: { icon: '!', iconCls: 'running',   text: '수동 설치', badgeCls: 'running'   },
  };
  const m = map[status];
  if (!m) return;
  icon.textContent  = m.icon;  icon.className  = `dep-icon ${m.iconCls}`;
  badge.textContent = m.text;  badge.className = `dep-badge ${m.badgeCls}`;
}

async function checkDeps() {
  depList.innerHTML = '';
  depInstallTerminal.innerHTML = '';
  setModalSection(true, false, false, false, true, false, false, false);

  try {
    const deps    = await invoke('check_dependencies');
    const missing = renderDepList(deps);

    if (missing.length === 0) {
      closeModal();
      if (pendingAction) { const fn = pendingAction; pendingAction = null; fn(); }
      return;
    }

    const brewMissing = missing.some(d => d.name === 'brew');
    depInstallBtn.textContent = brewMissing
      ? 'Homebrew 설치 (Terminal 실행)'
      : `설치하기 (${missing.length}개)`;

    setModalSection(false, true, false, false, true, false, true, false);
  } catch (err) {
    depList.innerHTML = `<div class="dep-error">확인 중 오류: ${err}</div>`;
    setModalSection(false, true, false, false, true, true, false, false);
  }
}

// ── Dependency install ────────────────────────────────────────────────────────

async function startDepInstall() {
  if (unlistenDepInstall)  { unlistenDepInstall();  unlistenDepInstall  = null; }
  if (unlistenDepComplete) { unlistenDepComplete(); unlistenDepComplete = null; }

  setModalSection(false, true, false, true, false, false, false, false);
  depInstallTerminal.innerHTML = '';
  let finished = false;

  unlistenDepInstall = await listen('dep-install-progress', (event) => {
    const { step, message, status } = event.payload;
    updateDepItem(step, status);
    const typeMap = { done: 'success', error: 'error', running: 'progress', skip: 'info', needs_interaction: 'info' };
    logTo(depInstallTerminal, typeMap[status] || 'info', message);
    if (status === 'needs_interaction') {
      depNeedsInteraction.style.display = 'block';
      depRecheckBtn.style.display = 'inline-flex';
      depCancelBtn.style.display  = 'inline-flex';
    }
    if (status === 'error' && !finished) {
      finished = true;
      depRecheckBtn.style.display = 'inline-flex';
      depCancelBtn.style.display  = 'inline-flex';
    }
  });

  unlistenDepComplete = await listen('dep-install-complete', () => {
    finished = true;
    logTo(depInstallTerminal, 'success', '모든 소프트웨어 설치 완료!');
    depProceedBtn.style.display = 'inline-flex';
    depCancelBtn.style.display  = 'inline-flex';
    refreshStatusBar();
  });

  try {
    await invoke('install_dependencies');
  } catch (err) {
    logTo(depInstallTerminal, 'error', `설치 시작 실패: ${err}`);
    depRecheckBtn.style.display = 'inline-flex';
    depCancelBtn.style.display  = 'inline-flex';
  }
}

// ── Extraction ────────────────────────────────────────────────────────────────

function resetProgress() {
  progressTitle.textContent   = '준비 중...';
  progressPercent.textContent = '0%';
  progressBarFill.style.width = '0%';
  progressStatus.textContent  = '추출 작업을 준비하고 있습니다.';
  openPdfButton.style.display = 'none';
  terminalConsole.innerHTML   = '';
  generatedPdfPath            = null;
}

function setControlsDisabled(disabled) {
  linkInput.disabled     = disabled;
  passwordInput.disabled = disabled;
  filenameInput.disabled = disabled;
  folderPickBtn.disabled = disabled;
  addQueueBtn.disabled   = disabled;
  if (!disabled) renderQueue(); // re-evaluate startQueueBtn state
  else startQueueBtn.disabled = true;
}

// Promise-based single extraction — resolves 'done' | 'error' when complete
function runSingleExtraction(item) {
  return new Promise(async (resolve) => {
    if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }

    unlistenProgress = await listen('extraction-progress', (event) => {
      const { status, message, page, total } = event.payload;

      if (status === 'info') {
        logTo(terminalConsole, 'info', message);
        progressStatus.textContent = message;
      } else if (status === 'progress') {
        logTo(terminalConsole, 'progress', message);
        if (page && total) {
          const pct = Math.round((page / total) * 90);
          progressPercent.textContent = `${pct}%`;
          progressBarFill.style.width = `${pct}%`;
          progressTitle.textContent   = `문서 추출 중 (${page}/${total})`;
          progressStatus.textContent  = `${page}번째 페이지 추출 완료`;
        }
      } else if (status === 'compiling') {
        logTo(terminalConsole, 'info', message);
        progressTitle.textContent   = 'PDF 변환 중';
        progressPercent.textContent = '95%';
        progressBarFill.style.width = '95%';
        progressStatus.textContent  = message;
      } else if (status === 'success') {
        item.pdfPath    = message;
        generatedPdfPath = message;
        logTo(terminalConsole, 'success', `성공: PDF 저장 → ${message}`);
        progressTitle.textContent   = '추출 완료!';
        progressPercent.textContent = '100%';
        progressBarFill.style.width = '100%';
        progressStatus.textContent  = 'PDF 파일이 성공적으로 저장되었습니다.';
        openPdfButton.style.display = 'block';
        if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
        resolve('done');
      } else if (status === 'error') {
        logTo(terminalConsole, 'error', message);
        progressTitle.textContent  = '작업 실패';
        progressStatus.textContent = `오류: ${message}`;
        if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
        resolve('error');
      }
    });

    try {
      const { url, password, customFilename, outputFolder } = item;
      await invoke('start_extraction', { url, password, customFilename, outputFolder });
    } catch (err) {
      logTo(terminalConsole, 'error', `백엔드 오류: ${err}`);
      if (unlistenProgress) { unlistenProgress(); unlistenProgress = null; }
      resolve('error');
    }
  });
}

async function processQueue() {
  isProcessing = true;
  setControlsDisabled(true);
  progressArea.style.display = 'block';

  for (const item of queue) {
    if (item.status !== 'pending') continue;

    item.status = 'running';
    renderQueue();
    resetProgress();

    const label = item.customFilename || item.url.slice(-30);
    progressTitle.textContent = `준비 중: ${label}`;
    logTo(terminalConsole, 'info', `시작: ${label}`);

    const result = await runSingleExtraction(item);
    item.status  = result;
    renderQueue();
  }

  isProcessing = false;
  setControlsDisabled(false);
}

function startQueue() {
  if (queue.filter(i => i.status === 'pending').length === 0) return;
  pendingAction = processQueue;
  depModal.classList.add('visible');
  checkDeps();
}

// ── Event listeners ───────────────────────────────────────────────────────────

passwordToggle.addEventListener('click', () => {
  const isHidden = passwordInput.type === 'password';
  passwordInput.type         = isHidden ? 'text' : 'password';
  passwordToggle.textContent = isHidden ? '비표시' : '표시';
});

openPdfButton.addEventListener('click', async () => {
  if (!generatedPdfPath) return;
  try {
    await invoke('open_file', { path: generatedPdfPath });
    logTo(terminalConsole, 'info', 'PDF 파일을 열었습니다.');
  } catch (err) {
    logTo(terminalConsole, 'error', `파일 열기 실패: ${err}`);
  }
});

folderPickBtn.addEventListener('click', async () => {
  try {
    const selected = await openDialog({ directory: true, multiple: false, title: '출력 폴더 선택' });
    if (selected) {
      await invoke('save_output_folder', { path: selected });
      folderDisplay.value = selected;
    }
  } catch (err) {
    console.error('폴더 선택 실패:', err);
  }
});

addQueueBtn.addEventListener('click', addToQueue);
startQueueBtn.addEventListener('click', startQueue);

queueClearBtn.addEventListener('click', () => {
  queue = queue.filter(i => i.status === 'running');
  renderQueue();
});

depCancelBtn.addEventListener('click', () => {
  pendingAction = null;
  closeModal();
});

depRecheckBtn.addEventListener('click', async () => {
  depNeedsInteraction.style.display = 'none';
  await checkDeps();
});

depInstallBtn.addEventListener('click', startDepInstall);

depProceedBtn.addEventListener('click', () => {
  closeModal();
  if (pendingAction) { const fn = pendingAction; pendingAction = null; fn(); }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  refreshStatusBar();
  try {
    const folder = await invoke('get_output_folder');
    folderDisplay.value = folder;
  } catch {
    folderDisplay.value = '';
  }
}

init();
