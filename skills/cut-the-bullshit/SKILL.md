---
name: cut-the-bullshit
description: 사용자에게 보낼 긴 최종 답변을 독립 해석·다수결 판정하고 필요하면 별도 평가자가 다시 쓴다. Stop 훅이 계속 작업을 요구할 때 또는 여러 문단의 최종 결과를 내기 직전에 사용한다. 짧은 확인·질문, 코드 중심 답, 진행 보고, 계획에는 사용하지 않는다.
---

# Claude Code adapter

먼저 `${CLAUDE_PLUGIN_ROOT}/plugins/cut-the-bullshit/core/review-protocol.md`를 끝까지 읽고 그 공통 절차를 따른다. 이 파일은 Claude Code 표면을 공통 역할에 연결하는 어댑터일 뿐이며 검사 정책을 따로 정의하지 않는다.

## 역할 매핑

- 해석자: `cut-the-bullshit:ctb-interpreter`
- 판정자: `cut-the-bullshit:ctb-judge`
- 지적 평가자: 새 `cut-the-bullshit:ctb-evaluator` 호출에 `모드: 지적`
- 고쳐쓰기 평가자: 별도의 새 `cut-the-bullshit:ctb-evaluator` 호출에 `모드: 고쳐쓰기`

해석자 2개와 판정자 3개를 같은 응답에서 동시에 시작한다. 각 회차와 평가 단계마다 새 호출을 쓰고 재사용하지 않는다. 완료 통지는 호스트가 밀어 주는 것을 기다리며 출력 파일, `sleep`, 빈 명령, 상태 문장으로 폴링하지 않는다. 꼭 블로킹 대기가 필요하면 대상마다 한 번만 기다린다.

## Claude Code 훅 경계

UserPromptSubmit 훅이 합성 체크리스트를 제공한다. 판정자 요약은 `${CLAUDE_PLUGIN_ROOT}/scripts/tally.mjs`로 넘기며, 이 진입점은 Codex와 같은 공통 구현을 사용한다.

Stop 훅은 Claude transcript에서 현재 사용자 턴의 스킬 호출과 역할 호출 순서를 읽어 공통 절차의 회차 구조를 확인한다. Claude Code가 제공하지 않는 Codex lifecycle 사건이나 도구 결과 근거를 지어내지 않는다. 도구 근거가 별도로 관찰되지 않으면 평가자에게 `관찰 정보 없음`으로 전달한다.

검사 과정에서는 사용자 화면에 진행 문장이나 판정 내용을 쓰지 않는다. 공통 절차가 확정한 최종 메시지 하나만 낸다.
