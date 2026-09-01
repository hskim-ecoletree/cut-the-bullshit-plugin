# Cut The Bullshit for Claude Code and Codex

긴 최종 답변을 사용자에게 보내기 전에 독립 해석과 다수결 판정을 거치고, 필요한 경우 별도 평가자가 답을 다시 쓰게 하는 Codex 플러그인입니다.

## Codex 설치

Node.js 20 이상과 인증된 Codex CLI가 필요합니다.

```sh
codex plugin marketplace add hskim-ecoletree/cut-the-bullshit-plugin --ref v0.1.1
codex plugin add cut-the-bullshit@ctb-local
```

설치한 뒤 새 Codex 대화를 시작하세요. 긴 최종 답변에는 훅이 자동으로 검사 문맥을 제공합니다. 명시적으로 실행하려면 다음처럼 요청할 수 있습니다.

```text
$cut-the-bullshit을 사용해 이 답을 검사해.
```

## Claude Code 설치

```sh
git clone --branch v0.1.1 --depth 1 https://github.com/hskim-ecoletree/cut-the-bullshit-plugin.git
claude --plugin-dir "$(pwd)/cut-the-bullshit-plugin"
```

서브에이전트 목록에서 `cut-the-bullshit:ctb-judge`를 확인할 수 있습니다. 훅이나 역할 파일을 갱신한 뒤에는 Claude Code를 새로 시작하세요.

## 포함 항목

- 두 독립 해석자와 세 독립 판정자의 검사 절차
- 지적 평가자와 고쳐쓰기 평가자
- Codex `UserPromptSubmit`·`Stop` 훅
- 한국어 및 공통 체크리스트
- 비대화형 실행에서 최종 답만 내보내는 buffered wrapper

## 지원 범위와 데이터

Codex CLI 0.152.0, Claude Code 2.1.252, Node.js 22.15.0에서 검증했습니다. 훅 상태는 사용자 기기의 로컬 데이터에만 저장되며 플러그인 자체는 외부 서비스로 데이터를 보내지 않습니다. 역할 입력에 민감한 원문을 넣지 말고, 강한 격리가 필요한 작업에는 사용하지 마세요.

두 호스트는 `plugins/cut-the-bullshit/core/`의 면제 판정, 체크리스트 합성, 다수결, 검사 프로토콜을 함께 사용합니다. Claude Code의 transcript 훅과 Codex의 lifecycle 훅 및 역할 호출 파일만 호스트 어댑터로 분리됩니다.

공식 패키징 구조는 `.codex-plugin/plugin.json`, `skills/`, `hooks/`, `agents/`, `scripts/`, `checklists/`로 구성됩니다.
