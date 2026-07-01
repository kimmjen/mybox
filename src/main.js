const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI_PLUGIN_DIALOG__;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const linkInput        = document.getElementById('link-input');
const passwordInput    = document.getElementById('password-input');
const filenameInput    = document.getElementById('filename-input');
const folderDisplay    = document.getElementById('folder-display');
const folderPickBtn    = document.getElementById('folder-pick-btn');
const passwordToggle   = document.getElementById('password-toggle');
const extractButton    = document.getElementById('extract-button');
const progressArea     = document.getElementById('progress-area');
const progressTitle    = document.getElementById('progress-title');
const progressPercent  = document.getElementById('progress-percent');
const progressBarFill  = document.getElementById('progress-bar-fill');
const progressStatus   = document.getElementById('progress-status');
const openPdfButton    = document.getElementById('open-pdf-button');
const terminalConsole  = document.getElementById('terminal-console');

const depModal           = document.getElementById('dep-modal');
const depChecking        = document.getElementById('dep-checking');
const depList            = document.getElementById('dep-list');
const depNeedsInteraction = document.getElementById('dep-needs-interaction');
const depInstallTerminal = document.getElementById('dep-install-terminal');
const depCancelBtn       = document.getElementById('dep-cancel-btn');
const depRecheckBtn      = document.getElementById('dep-recheck-btn');
const depInstallBtn      = document.getElementById('dep-install-btn');
const depProceedBtn      = document.getElementById('dep-proceed-btn');

// ── Status bar ────────────────────────────────────────────────────────────────

function setDot(depName, state) { // state: 'checking' | 'ok' | 'missing'
  const item = document.querySelector(`.dep-status-bar [data-dep="${depName}"] .dot`);
  if (item) { item.className = `dot ${state}`; }
}

async function refreshStatusBar() {
  try {
    const deps = await invoke('check_dependencies');
    deps.forEach(d => setDot(d.name, d.installed ? 'ok' : 'missing'));
  } catch {
    ['brew','nvm','node','pyenv','python','pillow'].forEach(n => setDot(n, 'missing'));
  }
}

let unlistenProgress   = null;
let unlistenDepInstall = null;
let unlistenDepComplete = null;
let generatedPdfPath   = null;
let pendingExtraction  = null; // { url, password }

// ── Helpers ───────────────────────────────────────────────────────────────────

function logTo(container, type, message) {
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function setModalSection(checking, list, warning, terminal, cancelVisible, recheckVisible, installVisible, proceedVisible) {
  depChecking.style.display        = checking  ? 'flex' : 'none';
  depList.style.display            = list      ? 'block' : 'none';
  depNeedsInteraction.style.display = warning  ? 'block' : 'none';
  depInstallTerminal.style.display  = terminal ? 'block' : 'none';
  depCancelBtn.style.display        = cancelVisible  ? 'inline-flex' : 'none';
  depRecheckBtn.style.display       = recheckVisible ? 'inline-flex' : 'none';
  depInstallBtn.style.display       = installVisible ? 'inline-flex' : 'none';
  depProceedBtn.style.display       = proceedVisible ? 'inline-flex' : 'none';
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
    done:             { icon: '✓', iconCls: 'installed', text: '설치됨',  badgeCls: 'installed' },
    skip:             { icon: '✓', iconCls: 'installed', text: '설치됨',  badgeCls: 'installed' },
    running:          { icon: '⟳', iconCls: 'running',   text: '설치 중', badgeCls: 'running'   },
    error:            { icon: '✗', iconCls: 'missing',   text: '실패',    badgeCls: 'missing'   },
    needs_interaction:{ icon: '!', iconCls: 'running',   text: '수동 설치', badgeCls: 'running' },
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
    const deps = await invoke('check_dependencies');
    const missing = renderDepList(deps);

    if (missing.length === 0) {
      closeModal();
      if (pendingExtraction) {
        const { url, password, customFilename, outputFolder } = pendingExtraction;
        pendingExtraction = null;
        runExtraction(url, password, customFilename, outputFolder);
      }
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
  // 이전 리스너가 남아있으면 먼저 해제
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
  progressTitle.textContent    = '준비 중...';
  progressPercent.textContent  = '0%';
  progressBarFill.style.width  = '0%';
  progressStatus.textContent   = '추출 작업을 준비하고 있습니다.';
  openPdfButton.style.display  = 'none';
  terminalConsole.innerHTML    = '';
  generatedPdfPath             = null;
}

function setInputsDisabled(disabled) {
  linkInput.disabled     = disabled;
  passwordInput.disabled = disabled;
  filenameInput.disabled = disabled;
  folderPickBtn.disabled = disabled;
  extractButton.disabled = disabled;
}

async function runExtraction(url, password, customFilename = '', outputFolder = '') {
  setInputsDisabled(true);
  progressArea.style.display = 'block';
  resetProgress();
  logTo(terminalConsole, 'info', '추출 엔진을 가동합니다. 대기해 주세요...');

  if (unlistenProgress) unlistenProgress();
  unlistenProgress = await listen('extraction-progress', (event) => {
    const { status, message, page, total } = event.payload;

    if (status === 'info') {
      logTo(terminalConsole, 'info', message);
      progressStatus.textContent = message;
    } else if (status === 'progress') {
      logTo(terminalConsole, 'progress', message);
      if (page && total) {
        const pct = Math.round((page / total) * 90);
        progressPercent.textContent  = `${pct}%`;
        progressBarFill.style.width  = `${pct}%`;
        progressTitle.textContent    = `문서 추출 중 (${page}/${total})`;
        progressStatus.textContent   = `${page}번째 페이지 추출 완료`;
      }
    } else if (status === 'compiling') {
      logTo(terminalConsole, 'info', message);
      progressTitle.textContent   = 'PDF 변환 중';
      progressPercent.textContent = '95%';
      progressBarFill.style.width = '95%';
      progressStatus.textContent  = message;
    } else if (status === 'success') {
      generatedPdfPath = message;
      logTo(terminalConsole, 'success', `성공: PDF 저장 → ${generatedPdfPath}`);
      progressTitle.textContent   = '추출 완료!';
      progressPercent.textContent = '100%';
      progressBarFill.style.width = '100%';
      progressStatus.textContent  = 'PDF 파일이 성공적으로 다운로드 폴더에 저장되었습니다.';
      openPdfButton.style.display = 'block';
      setInputsDisabled(false);
    } else if (status === 'error') {
      logTo(terminalConsole, 'error', message);
      progressTitle.textContent  = '작업 실패';
      progressStatus.textContent = `오류: ${message}`;
      setInputsDisabled(false);
    }
  });

  try {
    logTo(terminalConsole, 'info', 'Rust 백엔드로 추출 작업을 요청합니다...');
    const result = await invoke('start_extraction', { url, password, customFilename, outputFolder });
    logTo(terminalConsole, 'success', `백엔드 작업 시작: ${result}`);
  } catch (err) {
    logTo(terminalConsole, 'error', `백엔드 작업 오류: ${err}`);
    progressTitle.textContent  = '작업 실패';
    progressStatus.textContent = '작업 실행 도중 오류가 발생했습니다.';
    setInputsDisabled(false);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

passwordToggle.addEventListener('click', () => {
  const isHidden = passwordInput.type === 'password';
  passwordInput.type      = isHidden ? 'text' : 'password';
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

extractButton.addEventListener('click', async () => {
  const url      = linkInput.value.trim();
  const password = passwordInput.value.trim();
  if (!url)      { alert('공유 링크를 입력해 주세요!'); return; }
  if (!password) { alert('비밀번호를 입력해 주세요!');  return; }

  const customFilename = filenameInput.value.trim().replace(/\.pdf$/i, '');
  const outputFolder   = folderDisplay.value.trim();
  pendingExtraction = { url, password, customFilename, outputFolder };
  depModal.classList.add('visible');
  await checkDeps();
});

depCancelBtn.addEventListener('click', () => {
  pendingExtraction = null;
  closeModal();
});

depRecheckBtn.addEventListener('click', async () => {
  depNeedsInteraction.style.display = 'none';
  await checkDeps();
});

depInstallBtn.addEventListener('click', startDepInstall);

depProceedBtn.addEventListener('click', () => {
  closeModal();
  if (pendingExtraction) {
    const { url, password, customFilename, outputFolder } = pendingExtraction;
    pendingExtraction = null;
    runExtraction(url, password, customFilename, outputFolder);
  }
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
