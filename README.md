# ⚡ Antigravity Quota Status Bar & Panel

**Antigravity 2.0** 창 최하단에 실시간 **LLM 모델별 사용 잔량(%)**과 **초기화까지 남은 시간(타이머)**을 상시 표시해 주는 경량 하단 상태바(Bottom Status Bar) & 사이드카 플러그인입니다.

우측 보조 패널(사이드바)을 차지하지 않아 다른 작업을 방해하지 않으며, 상태바의 모델을 클릭하면 전체 모델 상세 팝오버(Popover)를 확인할 수 있습니다.

---

## 📸 실행 화면 (Screenshot)

![Antigravity Quota Bottom Status Bar](./assets/screenshot.png)

---

## ✨ 주요 기능

1. **하단 고정 상태바 (25px)**
   - 우측 사이드바를 점유하지 않고 창 최하단에 깔끔하게 고정됩니다 (`calc(100dvh - 25px)` 자동 레이아웃 보정).
   - **Gemini 4 Argon**, **Gemini 3.8 Flash**, **Claude 5.5 (Opus/Sonnet 통합)** 3가지 핵심 모델 패밀리의 잔여 게이지 바, 남은 비율(%), 초기화까지 남은 시간을 한눈에 보여줍니다.
2. **클릭 시 상세 팝오버(Popover) 제공**
   - 하단 상태바의 **⚡ LLM Quota** 배지 또는 각 모델을 클릭하면 상태바 바로 위에 상세 팝오버 카드가 열리며, 전체 세부 모델(`GPT-OSS 120B` 포함)의 정확한 소수점 잔량과 리셋 시각을 확인할 수 있습니다.
3. **자동 5분 주기 갱신 & 즉시 새로고침**
   - 깜박임(Flickering) 없이 **5분마다 자동으로 최신 쿼터를 갱신**합니다.
   - 우측의 **↻ 새로고침** 버튼을 클릭하면 언제든 즉시 최신 사용량을 불러옵니다.
4. **Antigravity 실행 시 자동 시작 (`restart_policy: "always"`)**
   - 한 번만 설치해 두면 Antigravity를 켤 때마다 백그라운드 사이드카 데몬이 자동으로 실행되어 하단 상태바를 주입합니다.

---

## 🚀 설치 방법 (Windows PowerShell)

Node.js가 설치된 환경에서 PowerShell을 열고 아래 명령어를 실행하세요:

```powershell
git clone https://github.com/<YOUR_GITHUB_ID>/antigravity-quota-panel.git
cd antigravity-quota-panel
.\install.ps1
```

> **참고**: `install.ps1` 실행 시 아래 두 경로에 자동으로 파일이 복사되며, 이미 실행 중인 Antigravity 창이 있으면 재시작 없이 즉시 하단 상태바가 나타납니다.
> - 사이드카 경로: `~/.gemini/config/sidecars/antigravity_quota_panel`
> - 스킬 경로: `~/.gemini/config/skills/quota-panel`

---

## 🗑️ 제거 방법

```powershell
.\uninstall.ps1
```
제거 스크립트 실행 후 Antigravity를 재시작하면 원래 상태로 복구됩니다.

---

## 📁 파일 구조

```text
antigravity-quota-panel/
├── assets/
│   └── screenshot.png   # 하단 상태바 실행 캡처 이미지
├── sidecar.json         # Antigravity 사이드카 메타데이터 (restart_policy: always)
├── server.cjs           # 로컬 language_server 쿼터 조회 및 CDP 하단 상태바 주입 서버
├── ui.html              # 독립 실행형 웹 대시보드 뷰
├── SKILL.md             # /quota-panel 슬래시 커맨드 연동 스킬
├── install.ps1          # Windows 원클릭 설치 스크립트
├── uninstall.ps1        # Windows 원클릭 제거 스크립트
└── README.md            # 설명서
```
