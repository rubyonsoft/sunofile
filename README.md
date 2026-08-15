# Suno 계정 전체 음악 백업

로그인한 Suno 계정의 활성 Workspace와 보관된 Workspace를 찾아, 계정에 표시되는 본인 곡을 한 번씩 백업하는 Windows용 Playwright 프로그램입니다.

- WAV 및 MP3
- 가사
- 생성 프롬프트 및 스타일 프롬프트
- 곡 메타데이터 JSON
- Workspace 간 Suno 곡 ID 중복 제거
- 중단 후 재실행 및 누락 파일만 이어받기
- Chrome 또는 탭 종료 시 자동 복구

> 이 프로젝트는 Suno의 공식 도구가 아닙니다. 본인이 접근하고 다운로드할 권한이 있는 곡에만 사용하고, Suno의 이용 약관과 서비스 정책을 준수하세요.

## 저장 구조

곡은 처음 발견된 Workspace 폴더에 저장됩니다.

```text
downloads/
├─ account-download-history.json
└─ 작곡용/
   ├─ 001 - 달빛 아래 너를 그려.wav
   ├─ 001 - 달빛 아래 너를 그려.mp3
   ├─ 001 - 달빛 아래 너를 그려 - lyrics.txt
   ├─ 001 - 달빛 아래 너를 그려 - prompt.txt
   └─ 001 - 달빛 아래 너를 그려 - metadata.json
```

`account-download-history.json`은 계정 전체의 곡 ID, 소속 Workspace, 파일 경로와 완료 상태를 기록합니다. 이전 버전에서 받은 Workspace별 WAV와 `download-history.json`도 자동으로 승계하므로 정상 파일은 다시 다운로드하지 않습니다.

## 준비물

- Windows 10 또는 11
- Google Chrome
- Node.js 20 이상
- WAV 다운로드 기능이 포함된 Suno 구독(원본 WAV가 필요한 경우)

### Node.js 설치

1. [Node.js 공식 다운로드 페이지](https://nodejs.org/)에서 LTS 버전의 Windows Installer(`.msi`)를 받습니다.
2. 설치 프로그램을 실행하고 기본 옵션으로 설치합니다. `Add to PATH` 옵션은 켜 둡니다.
3. 열려 있던 PowerShell 또는 명령 프롬프트를 닫고 새 창을 엽니다.
4. 다음 명령으로 설치를 확인합니다.

```powershell
node --version
npm --version
```

`node`가 명령으로 인식되지 않으면 Windows를 다시 로그인하거나 재부팅한 뒤 확인하세요.

## 처음 설치

PowerShell에서 다음 명령을 실행합니다.

```powershell
git clone https://github.com/rubyonsoft/sunofile.git
cd sunofile
Copy-Item config.example.json config.json
npm install
```

Git이 없다면 GitHub 페이지의 `Code` → `Download ZIP`으로 받아 압축을 푼 뒤, 그 폴더에서 `Copy-Item config.example.json config.json`과 `npm install`을 실행해도 됩니다.

그다음 `config.json`의 `workspaceDiscoveryUrl`을 본인 계정의 Workspace 주소 하나로 바꿉니다.

```json
{
  "workspaceDiscoveryUrl": "https://suno.com/create?wid=본인의_WORKSPACE_ID"
}
```

Suno에서 Workspace를 연 뒤 브라우저 주소창의 전체 주소를 복사하면 됩니다. 이 Workspace를 시작점으로 활성 및 보관 Workspace 목록을 자동 발견합니다.

## 로그인과 백업 실행

처음 실행하거나 로그인이 풀렸다면:

1. [Suno_로그인_준비.cmd](./Suno_로그인_준비.cmd)를 더블 클릭합니다.
2. 열린 일반 Chrome 창에서 Suno에 로그인합니다.
3. Suno 화면이 보이면 이 전용 Chrome 창을 완전히 닫습니다.
4. [Suno_전체_백업_실행.cmd](./Suno_전체_백업_실행.cmd)를 더블 클릭합니다.

Google 로그인은 자동화 브라우저를 차단할 수 있어 로그인 단계만 일반 Chrome으로 분리했습니다. 전용 로그인 정보는 프로젝트의 `.browser-profile` 폴더에 저장되며 평소 사용하는 Chrome 프로필에는 영향을 주지 않습니다.

PowerShell에서 직접 실행할 수도 있습니다.

```powershell
npm start
```

`Suno_WAV_백업_실행.cmd`도 호환성을 위해 남아 있으며 전체 백업 프로그램을 실행합니다.

## 먼저 한 곡만 시험하기

처음에는 한 곡만 처리해 보는 것을 권장합니다.

```powershell
npm start -- --limit 1
```

파일을 받지 않고 계정 전체의 고유 곡 목록만 확인하려면 다음 명령을 사용합니다.

```powershell
npm run scan
```

목록 확인도 일부 곡으로 제한할 수 있습니다.

```powershell
npm run scan -- --limit 10
```

## 중단 후 재실행

언제든 `Ctrl+C`로 중단할 수 있습니다. 현재 처리 중인 항목의 기록을 저장한 뒤 종료합니다. 같은 명령을 다시 실행하면 다음 항목을 각각 검사합니다.

- 유효한 WAV 헤더가 있는지
- 유효한 MP3 헤더가 있는지
- 가사, 프롬프트, 메타데이터 파일이 비어 있지 않은지

이미 있는 정상 파일은 건너뛰고 누락되거나 손상된 파일만 보충합니다. 장시간 실행 중 전용 Chrome 탭이나 브라우저가 닫히면 새 탭 또는 Chrome을 자동으로 열고 중단된 곡부터 다시 시작합니다.

## 설정

처음에는 [config.example.json](./config.example.json)을 `config.json`으로 복사합니다. `config.json`에는 다음 값을 설정할 수 있습니다.

- `workspaceDiscoveryUrl`: 계정에 속한 Workspace 주소 하나
- `includeArchivedWorkspaces`: `true`이면 보관된 Workspace도 포함
- `downloadDirectory`: 결과 저장 폴더
- `delayBetweenDownloadsMs`: 곡 사이 대기 시간
- `downloadTimeoutMs`: WAV 준비와 파일 다운로드 제한 시간
- `downloadRetryCount`: 곡별 재시도 횟수
- `browserRestartCount`: Chrome 종료 시 Workspace별 자동 복구 횟수

요청 간격을 너무 짧게 줄이지 않는 것이 좋습니다.

## 개인정보와 음악 파일 보호

다음 항목은 `.gitignore`에 포함되어 Git에 올라가지 않습니다.

- `config.json`
- `.browser-profile/` 로그인 세션
- `downloads/`의 음악, 가사, 프롬프트 및 기록
- `logs/`의 오류 화면과 진단 정보
- 모든 `*.wav`, `*.mp3`, `*.m4a`, `*.flac`, `*.aac`, `*.ogg` 파일

특히 `.browser-profile`은 로그인 세션을 포함할 수 있으므로 공유하거나 Git에 강제로 추가하지 마세요.

## 문제 해결

- WAV가 계속 실패하면 해당 계정의 Suno 구독에서 WAV 다운로드가 지원되는지 확인하세요.
- Suno 화면 구성이 바뀌면 Download 메뉴 선택자를 수정해야 할 수 있습니다. 실패한 곡은 건너뛰며 `logs` 폴더에 화면과 버튼 정보를 남깁니다.
- 곡이 많으면 전체 백업에 여러 시간이 걸리고 저장 공간도 많이 필요합니다. 프로그램은 재실행을 전제로 설계되어 있습니다.
- 이 프로그램은 로그인한 계정의 Workspace 목록에 나타나는 곡만 대상으로 합니다.

## 테스트

```powershell
npm test
```
