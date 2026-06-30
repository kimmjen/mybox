use tauri::Manager;
use tauri::Emitter;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::env;

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
struct ExtractionPayload {
    status: String,
    message: String,
    page: Option<u32>,
    total: Option<u32>,
}

#[derive(serde::Serialize)]
struct DepStatus {
    name: String,
    label: String,
    installed: bool,
}

#[derive(Clone, serde::Serialize)]
struct DepInstallEvent {
    step: String,
    message: String,
    status: String,
}

// ── Dependency detection ──────────────────────────────────────────────────────

fn brew_path() -> Option<String> {
    for p in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if Path::new(p).exists() { return Some(p.to_string()); }
    }
    None
}

fn nvm_sh_path() -> Option<String> {
    let home = env::var("HOME").ok()?;
    let candidates = [
        format!("{}/.nvm/nvm.sh", home),
        "/opt/homebrew/opt/nvm/nvm.sh".to_string(),
        "/usr/local/opt/nvm/nvm.sh".to_string(),
    ];
    for p in &candidates {
        if Path::new(p).exists() { return Some(p.clone()); }
    }
    None
}

fn node_via_nvm() -> Option<String> {
    let home = env::var("HOME").ok()?;
    let nvm_sh = nvm_sh_path()?;
    let script = format!(
        r#"export NVM_DIR="{home}/.nvm"; source '{nvm_sh}' > /dev/null 2>&1; which node 2>/dev/null"#
    );
    let out = Command::new("bash").args(["-c", &script]).output().ok()?;
    if out.status.success() {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() { return Some(p); }
    }
    None
}

fn pyenv_bin() -> Option<String> {
    let home = env::var("HOME").ok()?;
    let candidates = [
        format!("{}/.pyenv/bin/pyenv", home),
        "/opt/homebrew/bin/pyenv".to_string(),
        "/usr/local/bin/pyenv".to_string(),
    ];
    for p in &candidates {
        if Path::new(p).exists() { return Some(p.clone()); }
    }
    None
}

const MYBOX_DIR: &str = ".mybox";
const VENV_NAME: &str = "mybox-env";
const PYTHON_VER: &str = "3.12.3";
const MIN_PYTHON: (u32, u32) = (3, 8);  // Python >= 3.8
const MIN_NODE: u32 = 18;               // Node.js >= 18

fn python_in_venv() -> Option<String> {
    let home = env::var("HOME").ok()?;
    let p = format!("{}/.pyenv/versions/{}/bin/python3", home, VENV_NAME);
    if Path::new(&p).exists() { Some(p) } else { None }
}

fn parse_python_version(output: &str) -> Option<(u32, u32)> {
    // "Python 3.12.3" → (3, 12)
    let ver = output.split_whitespace().nth(1)?;
    let mut parts = ver.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn find_python3() -> Option<String> {
    // 1. pyenv 가상환경 우선 (격리된 환경)
    if let Some(p) = python_in_venv() { return Some(p); }
    // 2. 시스템 python3 / python
    for candidate in ["python3", "python"] {
        if let Ok(out) = Command::new(candidate).arg("--version").output() {
            let text = String::from_utf8_lossy(&out.stdout).to_string()
                + &String::from_utf8_lossy(&out.stderr).to_string();
            if let Some((maj, min)) = parse_python_version(&text) {
                if (maj, min) >= MIN_PYTHON {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    None
}

fn mybox_modules_dir() -> Option<PathBuf> {
    let home = env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(MYBOX_DIR).join("node_modules"))
}

fn playwright_package_installed() -> bool {
    mybox_modules_dir()
        .map(|d| d.join("playwright").exists())
        .unwrap_or(false)
}

fn playwright_browser_installed() -> bool {
    let home = env::var("HOME").ok().unwrap_or_default();
    for base in [
        format!("{}/Library/Caches/ms-playwright", home),
        format!("{}/.cache/ms-playwright", home),
    ] {
        if let Ok(d) = Path::new(&base).read_dir() {
            if d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("chromium")) {
                return true;
            }
        }
    }
    false
}

fn pillow_installed(python: &str) -> bool {
    Command::new(python)
        .args(["-c", "import PIL"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn sanitize_filename(name: &str) -> String {
    let s: String = name.chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() { "mybox_document".to_string() } else { s }
}

// ── Shell config ─────────────────────────────────────────────────────────────

fn zshrc_path() -> Option<PathBuf> {
    let home = env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".zshrc"))
}

fn append_to_zshrc_if_missing(marker: &str, block: &str) {
    let Some(path) = zshrc_path() else { return };
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(marker) { return; }
    let content = format!("\n{}\n", block);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| { use std::io::Write; f.write_all(content.as_bytes()) });
}

// ── Script path resolution ────────────────────────────────────────────────────

fn get_script_path(app_handle: &tauri::AppHandle, filename: &str) -> PathBuf {
    // 1. Tauri resource_dir (번들 앱의 Contents/Resources/)
    if let Ok(resource_path) = app_handle.path().resource_dir() {
        let p = resource_path.join(filename);
        if p.exists() { return p; }
        // Tauri v2: "../file" → "_up_/file"
        let p = resource_path.join("_up_").join(filename);
        if p.exists() { return p; }
        let p = resource_path.join("resources").join(filename);
        if p.exists() { return p; }
    }
    // 2. 실행 파일 기준 — macOS .app: Contents/MacOS/ → Contents/Resources/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if let Some(contents) = exe_dir.parent() {
                let base = contents.join("Resources");
                let p = base.join(filename);
                if p.exists() { return p; }
                let p = base.join("_up_").join(filename);
                if p.exists() { return p; }
            }
        }
    }
    // 3. 개발 모드 CWD (src-tauri/ → 프로젝트 루트)
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(parent) = cwd.parent() {
            let p = parent.join(filename);
            if p.exists() { return p; }
        }
        let p = cwd.join(filename);
        if p.exists() { return p; }
    }
    PathBuf::from(filename)
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn check_dependencies() -> Vec<DepStatus> {
    let brew       = brew_path().is_some();
    let nvm        = nvm_sh_path().is_some();
    let node       = node_via_nvm().is_some();
    let playwright = playwright_package_installed() && playwright_browser_installed();
    let pyenv      = pyenv_bin().is_some();
    let python     = find_python3().is_some();
    let pillow     = find_python3().map(|p| pillow_installed(&p)).unwrap_or(false);

    vec![
        DepStatus { name: "brew".into(),       label: "Homebrew".into(),                                                        installed: brew },
        DepStatus { name: "nvm".into(),        label: "nvm (Node Version Manager)".into(),                                      installed: nvm },
        DepStatus { name: "node".into(),       label: format!("Node.js ≥ {} (via nvm)", MIN_NODE),                              installed: node },
        DepStatus { name: "playwright".into(), label: "Playwright + Chromium".into(),                                           installed: playwright },
        DepStatus { name: "pyenv".into(),      label: "pyenv".into(),                                                           installed: pyenv },
        DepStatus { name: "python".into(),     label: format!("Python ≥ {}.{} (시스템 또는 pyenv)", MIN_PYTHON.0, MIN_PYTHON.1), installed: python },
        DepStatus { name: "pillow".into(),     label: "Pillow (이미지 → PDF 변환)".into(),                                      installed: pillow },
    ]
}

#[tauri::command]
fn install_dependencies(app_handle: tauri::AppHandle) -> Result<String, String> {
    std::thread::spawn(move || {
        let ah = app_handle.clone();
        let emit = move |step: &str, msg: &str, status: &str| {
            let _ = ah.emit("dep-install-progress", DepInstallEvent {
                step: step.to_string(),
                message: msg.to_string(),
                status: status.to_string(),
            });
        };

        // ── Homebrew ──────────────────────────────────────────────────────────
        if brew_path().is_none() {
            // Homebrew install requires interactive sudo — open Terminal
            let script = "#!/bin/bash\necho '=== Homebrew 설치 ==='\n/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\necho ''\necho '설치 완료! 이 창을 닫고 앱으로 돌아가 [다시 확인]을 눌러주세요.'\nread -p ''\n";
            let script_path = "/tmp/mybox_brew_install.sh";
            let _ = std::fs::write(script_path, script);
            let _ = Command::new("chmod").args(["755", script_path]).output();
            let _ = Command::new("open").args(["-a", "Terminal", script_path]).spawn();
            emit("brew", "Terminal에서 Homebrew 설치를 완료한 후 [다시 확인]을 눌러주세요.", "needs_interaction");
            return;
        }
        emit("brew", "Homebrew ✓", "skip");

        let brew = brew_path().unwrap();

        // ── nvm ───────────────────────────────────────────────────────────────
        if nvm_sh_path().is_none() {
            emit("nvm", "nvm 설치 중...", "running");
            let out = Command::new(&brew).args(["install", "nvm"]).output();
            match out {
                Ok(o) if o.status.success() => {
                    let home = env::var("HOME").unwrap_or_default();
                    let _ = std::fs::create_dir_all(format!("{}/.nvm", home));
                    append_to_zshrc_if_missing("NVM_DIR", concat!(
                        "# nvm\n",
                        "export NVM_DIR=\"$HOME/.nvm\"\n",
                        "[ -s \"/opt/homebrew/opt/nvm/nvm.sh\" ] && \\. \"/opt/homebrew/opt/nvm/nvm.sh\"\n",
                        "[ -s \"/usr/local/opt/nvm/nvm.sh\" ]  && \\. \"/usr/local/opt/nvm/nvm.sh\"\n",
                        "[ -s \"$NVM_DIR/nvm.sh\" ]            && \\. \"$NVM_DIR/nvm.sh\""
                    ));
                    emit("nvm", "nvm 설치 완료 + ~/.zshrc 설정 ✓", "done");
                }
                Ok(o) => {
                    emit("nvm", &format!("nvm 설치 실패: {}", String::from_utf8_lossy(&o.stderr).trim()), "error");
                    return;
                }
                Err(e) => { emit("nvm", &format!("nvm 설치 실패: {}", e), "error"); return; }
            }
        } else {
            emit("nvm", "nvm ✓", "skip");
        }

        // ── Node.js ───────────────────────────────────────────────────────────
        if node_via_nvm().is_none() {
            emit("node", "Node.js LTS 설치 중... (수 분 소요)", "running");
            let home = env::var("HOME").unwrap_or_default();
            let nvm_sh = nvm_sh_path()
                .or_else(|| {
                    let p = "/opt/homebrew/opt/nvm/nvm.sh".to_string();
                    if Path::new(&p).exists() { Some(p) } else { None }
                })
                .or_else(|| {
                    let p = "/usr/local/opt/nvm/nvm.sh".to_string();
                    if Path::new(&p).exists() { Some(p) } else { None }
                })
                .unwrap_or_else(|| format!("{}/.nvm/nvm.sh", home));

            let script = format!(
                r#"export NVM_DIR="{home}/.nvm"; source '{nvm_sh}' 2>&1; nvm install --lts 2>&1; nvm alias default 'lts/*' 2>&1"#
            );
            let mut child = match Command::new("bash")
                .args(["-c", &script])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => { emit("node", &format!("Node.js 설치 실패: {}", e), "error"); return; }
            };
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().flatten() {
                    let l = line.trim().to_string();
                    if !l.is_empty() { emit("node", &l, "running"); }
                }
            }
            match child.wait() {
                Ok(s) if s.success() => emit("node", "Node.js 설치 완료 ✓", "done"),
                Ok(_) => { emit("node", "Node.js 설치에 실패했습니다.", "error"); return; }
                Err(e) => { emit("node", &format!("Node.js 설치 실패: {}", e), "error"); return; }
            }
        } else {
            emit("node", "Node.js ✓", "skip");
        }

        // ── Playwright 패키지 + Chromium ──────────────────────────────────────
        let home = env::var("HOME").unwrap_or_default();
        let mybox_dir = format!("{}/.mybox", home);
        if !playwright_package_installed() {
            emit("playwright", "playwright 패키지 설치 중...", "running");
            let _ = std::fs::create_dir_all(&mybox_dir);
            let pkg_json = r#"{"name":"mybox-deps","version":"1.0.0","dependencies":{"playwright":"^1.61.1"}}"#;
            let _ = std::fs::write(format!("{}/package.json", mybox_dir), pkg_json);

            let nvm_sh = nvm_sh_path().unwrap_or_else(|| format!("{}/.nvm/nvm.sh", home));
            let script = format!(
                r#"export NVM_DIR="{home}/.nvm"; source '{nvm_sh}' > /dev/null 2>&1; cd '{mybox_dir}' && npm install 2>&1"#
            );
            let mut child = match Command::new("bash")
                .args(["-c", &script])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => { emit("playwright", &format!("npm install 실패: {}", e), "error"); return; }
            };
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().flatten() {
                    let l = line.trim().to_string();
                    if !l.is_empty() { emit("playwright", &l, "running"); }
                }
            }
            match child.wait() {
                Ok(s) if s.success() => emit("playwright", "playwright 패키지 설치 완료", "running"),
                _ => { emit("playwright", "playwright 패키지 설치 실패", "error"); return; }
            }
        }

        if !playwright_browser_installed() {
            emit("playwright", "Chromium 브라우저 설치 중... (수 분 소요)", "running");
            let nvm_sh = nvm_sh_path().unwrap_or_else(|| format!("{}/.nvm/nvm.sh", home));
            let playwright_bin = format!("{}/node_modules/.bin/playwright", mybox_dir);
            let script = format!(
                r#"export NVM_DIR="{home}/.nvm"; source '{nvm_sh}' > /dev/null 2>&1; '{playwright_bin}' install chromium 2>&1"#
            );
            let mut child = match Command::new("bash")
                .args(["-c", &script])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => { emit("playwright", &format!("Chromium 설치 실패: {}", e), "error"); return; }
            };
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().flatten() {
                    let l = line.trim().to_string();
                    if !l.is_empty() { emit("playwright", &l, "running"); }
                }
            }
            match child.wait() {
                Ok(s) if s.success() => emit("playwright", "Playwright + Chromium 설치 완료 ✓", "done"),
                _ => { emit("playwright", "Chromium 설치 실패", "error"); return; }
            }
        } else {
            emit("playwright", "Playwright + Chromium ✓", "skip");
        }

        // ── pyenv ─────────────────────────────────────────────────────────────
        if pyenv_bin().is_none() {
            emit("pyenv", "pyenv 설치 중...", "running");
            let out = Command::new(&brew).args(["install", "pyenv"]).output();
            match out {
                Ok(o) if o.status.success() => {
                    append_to_zshrc_if_missing("PYENV_ROOT", concat!(
                        "# pyenv\n",
                        "export PYENV_ROOT=\"$HOME/.pyenv\"\n",
                        "[[ -d $PYENV_ROOT/bin ]] && export PATH=\"$PYENV_ROOT/bin:$PATH\"\n",
                        "eval \"$(pyenv init -)\""
                    ));
                    emit("pyenv", "pyenv 설치 완료 + ~/.zshrc 설정 ✓", "done");
                }
                Ok(o) => {
                    emit("pyenv", &format!("pyenv 설치 실패: {}", String::from_utf8_lossy(&o.stderr).trim()), "error");
                    return;
                }
                Err(e) => { emit("pyenv", &format!("pyenv 설치 실패: {}", e), "error"); return; }
            }
        } else {
            emit("pyenv", "pyenv ✓", "skip");
        }

        let pyenv = pyenv_bin().unwrap_or_else(|| "/opt/homebrew/bin/pyenv".to_string());

        // ── Python venv (pyenv install + python -m venv) ──────────────────────
        if python_in_venv().is_none() {
            let home = env::var("HOME").unwrap_or_default();
            emit("python", &format!("Python {} 설치 중... (5~15분 소요)", PYTHON_VER), "running");
            let mut child = match Command::new(&pyenv)
                .args(["install", "-s", PYTHON_VER])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => { emit("python", &format!("Python 설치 실패: {}", e), "error"); return; }
            };
            if let Some(stderr) = child.stderr.take() {
                for line in BufReader::new(stderr).lines().flatten() {
                    let l = line.trim().to_string();
                    if !l.is_empty() { emit("python", &l, "running"); }
                }
            }
            match child.wait() {
                Ok(s) if s.success() => {}
                Ok(_) => { emit("python", "Python 설치에 실패했습니다.", "error"); return; }
                Err(e) => { emit("python", &format!("Python 설치 실패: {}", e), "error"); return; }
            }

            // python -m venv (pyenv-virtualenv 플러그인 불필요)
            emit("python", &format!("{} 가상환경 생성 중...", VENV_NAME), "running");
            let python_bin = format!("{}/.pyenv/versions/{}/bin/python3", home, PYTHON_VER);
            let venv_path  = format!("{}/.pyenv/versions/{}", home, VENV_NAME);
            let out = Command::new(&python_bin).args(["-m", "venv", &venv_path]).output();
            match out {
                Ok(o) if o.status.success() => emit("python", "Python 환경 준비 완료 ✓", "done"),
                Ok(o) => {
                    emit("python", &format!("가상환경 생성 실패: {}", String::from_utf8_lossy(&o.stderr).trim()), "error");
                    return;
                }
                Err(e) => { emit("python", &format!("가상환경 생성 실패: {}", e), "error"); return; }
            }
        } else {
            emit("python", "Python 환경 ✓", "skip");
        }

        // ── Pillow ────────────────────────────────────────────────────────────
        let python = match python_in_venv() {
            Some(p) => p,
            None => { emit("pillow", "Python 경로를 찾을 수 없습니다.", "error"); return; }
        };

        if !pillow_installed(&python) {
            emit("pillow", "Pillow 설치 중...", "running");
            let out = Command::new(&python).args(["-m", "pip", "install", "Pillow"]).output();
            match out {
                Ok(o) if o.status.success() => emit("pillow", "Pillow 설치 완료 ✓", "done"),
                Ok(o) => {
                    emit("pillow", &format!("Pillow 설치 실패: {}", String::from_utf8_lossy(&o.stderr).trim()), "error");
                    return;
                }
                Err(e) => { emit("pillow", &format!("Pillow 설치 실패: {}", e), "error"); return; }
            }
        } else {
            emit("pillow", "Pillow ✓", "skip");
        }

        let _ = app_handle.emit("dep-install-complete", ());
    });

    Ok("started".into())
}

#[tauri::command]
fn start_extraction(app_handle: tauri::AppHandle, url: String, password: String, custom_filename: String) -> Result<String, String> {
    let downloads_dir = match app_handle.path().download_dir() {
        Ok(dir) => dir,
        Err(_) => return Err("Could not resolve system Downloads directory".into()),
    };
    let downloads_path = downloads_dir.to_string_lossy().into_owned();

    let extract_script = get_script_path(&app_handle, "extract.cjs");
    let compile_script = get_script_path(&app_handle, "compile.py");
    let extract_script_str = extract_script.to_string_lossy().into_owned();
    let compile_script_str = compile_script.to_string_lossy().into_owned();

    let home       = env::var("HOME").unwrap_or_default();
    let node_bin   = node_via_nvm().unwrap_or_else(|| "node".to_string());
    let python_bin = find_python3().unwrap_or_else(|| "python3".to_string());
    let node_path  = format!("{}/.mybox/node_modules", home);

    let app_handle_clone = app_handle.clone();

    std::thread::spawn(move || {
        let emit_status = |status: &str, message: &str, page: Option<u32>, total: Option<u32>| {
            let _ = app_handle_clone.emit("extraction-progress", ExtractionPayload {
                status: status.to_string(),
                message: message.to_string(),
                page,
                total,
            });
        };
        let mut doc_title = String::new();

        emit_status("info", "추출 엔진 (Node/Playwright) 가동 중...", None, None);

        let extract_cmd = Command::new(&node_bin)
            .env("NODE_PATH", &node_path)
            .arg(&extract_script_str)
            .arg(&url)
            .arg(&password)
            .arg(&downloads_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut child = match extract_cmd {
            Ok(c) => c,
            Err(e) => {
                emit_status("error", &format!("Node 실행 실패: {}", e), None, None);
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().flatten() {
                let trim_line = line.trim().to_string();
                if trim_line.is_empty() { continue; }

                if trim_line.starts_with("[TITLE]") {
                    doc_title = trim_line.replace("[TITLE]", "").trim().to_string();
                } else if trim_line.starts_with("[PROGRESS]") {
                    let content = trim_line.replace("[PROGRESS]", "");
                    let parts: Vec<&str> = content.split(" - ").collect();
                    if parts.len() >= 2 {
                        let progress_part = parts[0].trim();
                        let message_part = parts[1].trim();
                        let pages: Vec<&str> = progress_part.split('/').collect();
                        if pages.len() == 2 {
                            let page_num = pages[0].trim().parse::<u32>().unwrap_or(0);
                            let total_num = pages[1].trim().parse::<u32>().unwrap_or(0);
                            emit_status("progress", message_part, Some(page_num), Some(total_num));
                        }
                    }
                } else if trim_line.starts_with("[INFO]") {
                    emit_status("info", trim_line.replace("[INFO]", "").trim(), None, None);
                } else if trim_line.starts_with("ERROR") || trim_line.starts_with("FAILED") {
                    emit_status("error", &trim_line, None, None);
                }
            }
        }

        let extract_status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                emit_status("error", &format!("추출 프로세스 대기 에러: {}", e), None, None);
                return;
            }
        };

        if !extract_status.success() {
            let mut err_msg = String::new();
            if let Some(stderr) = child.stderr.take() {
                for line in BufReader::new(stderr).lines().flatten() {
                    err_msg.push_str(&line);
                    err_msg.push('\n');
                }
            }
            let display_msg = if err_msg.is_empty() {
                "페이지 추출에 실패했습니다. 공유 주소나 비밀번호를 다시 확인하세요.".to_string()
            } else {
                format!("페이지 추출 실패:\n{}", err_msg)
            };
            emit_status("error", &display_msg, None, None);
            return;
        }

        emit_status("compiling", "PDF 병합 엔진 (Python/Pillow) 가동 중...", None, None);

        let compile_title = if custom_filename.is_empty() { doc_title.clone() } else { custom_filename.clone() };
        let compile_cmd = Command::new(&python_bin)
            .arg(&compile_script_str)
            .arg(&downloads_path)
            .arg(&compile_title)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut compile_child = match compile_cmd {
            Ok(c) => c,
            Err(e) => {
                emit_status("error", &format!("Python 실행 실패: {}", e), None, None);
                return;
            }
        };

        if let Some(stdout) = compile_child.stdout.take() {
            for line in BufReader::new(stdout).lines().flatten() {
                let trim_line = line.trim().to_string();
                if trim_line.is_empty() { continue; }
                if trim_line.starts_with("[INFO]") {
                    emit_status("compiling", trim_line.replace("[INFO]", "").trim(), None, None);
                } else if trim_line.starts_with("ERROR") {
                    emit_status("error", &trim_line, None, None);
                }
            }
        }

        let compile_status = match compile_child.wait() {
            Ok(s) => s,
            Err(e) => {
                emit_status("error", &format!("컴파일 프로세스 대기 에러: {}", e), None, None);
                return;
            }
        };

        if compile_status.success() {
            let final_name = [&custom_filename, &doc_title]
                .iter()
                .find(|s| !s.is_empty())
                .map(|s| sanitize_filename(s))
                .unwrap_or_else(|| "mybox_document".to_string());
            let output_path = PathBuf::from(&downloads_path).join(format!("{}.pdf", final_name));
            let output_path_str = output_path.to_string_lossy().into_owned();
            let _ = Command::new("open").arg(&output_path_str).spawn();
            emit_status("success", &output_path_str, None, None);
        } else {
            emit_status("error", "PDF 컴파일 도중 에러가 발생했습니다.", None, None);
        }
    });

    Ok("Extraction task launched successfully".into())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_normal_name() {
        assert_eq!(sanitize_filename("TEST"), "TEST");
    }

    #[test]
    fn sanitize_keeps_korean() {
        assert_eq!(sanitize_filename("내 문서"), "내 문서");
    }

    #[test]
    fn sanitize_strips_special_chars() {
        assert_eq!(sanitize_filename("TEST<>:/\\|?*"), "TEST");
    }

    #[test]
    fn sanitize_empty_returns_fallback() {
        assert_eq!(sanitize_filename(""), "mybox_document");
    }

    #[test]
    fn sanitize_whitespace_only_returns_fallback() {
        assert_eq!(sanitize_filename("   "), "mybox_document");
    }

    #[test]
    fn sanitize_trims_whitespace() {
        assert_eq!(sanitize_filename("  hello  "), "hello");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_extraction,
            open_file,
            check_dependencies,
            install_dependencies
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
