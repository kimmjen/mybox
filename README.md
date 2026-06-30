# NAVER MYBOX Extractor

다운로드가 제한된 네이버 MYBOX 공유 문서를 PDF로 추출하는 macOS 데스크탑 앱입니다.

---

## 스크린샷

앱 실행 시 의존성 상태(Homebrew, nvm, Node.js, Playwright, pyenv, Python, Pillow)를 실시간 점검하고, 미설치 항목은 자동으로 설치합니다.

---

## 기술 스택

| 레이어 | 사용 기술 |
|--------|-----------|
| 앱 프레임워크 | [Tauri v2](https://tauri.app) (Rust 백엔드 + Vanilla JS 프론트엔드) |
| 문서 캡처 | Node.js + [Playwright](https://playwright.dev) (Headless Chromium) |
| PDF 변환 | Python 3 + [Pillow](https://python-pillow.org) |
| 패키지 관리 | nvm (Node.js), pyenv + venv (Python), Homebrew |

---

## 개발 환경 요구사항

빌드하려면 아래 도구가 로컬에 설치되어 있어야 합니다.

- **Rust** — https://rustup.rs
- **Node.js ≥ 18** — https://nodejs.org (또는 nvm)
- **Xcode Command Line Tools** — `xcode-select --install`

```bash
# Rust 설치 확인
rustc --version

# Node.js 설치 확인
node --version
```

---

## 설치 및 실행

### 1. 저장소 클론

```bash
git clone https://github.com/kimmjen/mybox.git
cd mybox
```

### 2. 의존성 설치

```bash
npm install
```

`package.json` 의존성:

```json
{
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  },
  "dependencies": {
    "playwright": "^1.61.1"
  }
}
```

### 3. 개발 모드 실행

```bash
npm run tauri dev
```

앱 창이 열리고 핫 리로드가 활성화됩니다.

### 4. 프로덕션 빌드 (.app + .dmg)

```bash
npm run tauri build
```

빌드 결과물 위치:

```
src-tauri/target/release/bundle/
├── macos/
│   └── MYBOX Extractor.app
└── dmg/
    └── MYBOX Extractor_1.0.0_aarch64.dmg
```

---

## 프로젝트 구조

```
mybox/
├── src/                        # 프론트엔드 (HTML/CSS/JS)
│   ├── index.html
│   ├── main.js
│   └── styles.css
├── src-tauri/                  # Tauri / Rust 백엔드
│   ├── src/lib.rs              # 핵심 로직 (의존성 감지·설치, 추출 실행)
│   └── tauri.conf.json         # 앱 설정 (이름, 창 크기, 리소스 번들)
├── extract.cjs                 # Playwright 문서 캡처 스크립트
├── compile.py                  # PNG → PDF 변환 스크립트
├── test_compile.py             # compile.py 단위 테스트
└── package.json
```

---

## 런타임 의존성 (앱이 자동 설치)

앱 실행 시 아래 항목을 자동으로 감지하고, 없으면 설치를 안내하거나 자동 설치합니다.

| 항목 | 최소 버전 | 설치 방법 |
|------|-----------|-----------|
| Homebrew | - | Terminal에서 수동 (sudo 필요) |
| nvm | - | Homebrew로 자동 설치 |
| Node.js | ≥ 18 | nvm으로 자동 설치 |
| Playwright (Chromium) | - | npm으로 자동 설치 (`~/.mybox/`) |
| pyenv | - | Homebrew로 자동 설치 |
| Python | ≥ 3.8 | pyenv로 자동 설치 (3.12.3) |
| Pillow | - | pip으로 자동 설치 (venv 내) |

런타임 파일은 `~/.mybox/` 에 저장되어 앱을 재설치해도 유지됩니다.

---

## 사용 방법

1. **앱 실행** — `MYBOX Extractor.app` 또는 DMG로 설치 후 실행
2. **의존성 확인** — 상단 상태 바의 점(●)이 모두 초록색이 될 때까지 대기 (빨간 점은 자동 설치 진행)
3. **링크 입력** — 네이버 MYBOX 공유 링크 붙여넣기 (`https://naver.me/...`)
4. **비밀번호 입력** — 공유 링크의 비밀번호 입력
5. **파일명 입력** — (선택) 저장할 PDF 파일명 입력. 비워두면 문서 제목으로 자동 설정
6. **추출 시작** — 버튼 클릭 후 진행 상황 확인
7. **PDF 열기** — 완료 후 "생성된 PDF 파일 열기" 버튼 클릭

저장 위치: 시스템 **Downloads** 폴더

---

## 테스트

`compile.py` 파일명 처리 단위 테스트:

```bash
python3 test_compile.py
```

테스트 항목:
- 커스텀 파일명 적용 (`TEST` → `TEST.pdf`)
- 한글 파일명 지원
- 파일명 미지정 시 `mybox_document.pdf` fallback
- 특수문자 sanitize (`<>:/\|?*` 제거)

---

## 주의사항

- **macOS 전용**입니다. (Windows/Linux 미지원)
- Playwright가 Chromium을 실행하므로 첫 실행 시 수 분이 소요될 수 있습니다.
- 개인 소유 또는 열람 권한이 있는 문서에만 사용하세요.
