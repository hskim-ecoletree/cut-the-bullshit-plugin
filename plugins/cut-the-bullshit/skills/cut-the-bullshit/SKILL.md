---
name: cut-the-bullshit
description: 사용자에게 보낼 긴 최종 답변을 독립 해석·다수결 판정하고 필요하면 별도 평가자가 다시 쓴다. Stop hook이 계속 작업을 요구할 때 또는 여러 문단의 최종 결과를 내기 직전에 사용한다. 짧은 확인·질문, 코드 중심 답, 진행 보고, 계획에는 사용하지 않는다.
---

# Codex adapter

먼저 `../../core/review-protocol.md`를 끝까지 읽고 그 공통 절차를 따른다. 이 파일은 Codex 표면을 공통 역할에 연결하는 어댑터일 뿐이며 검사 정책을 따로 정의하지 않는다.

## 역할 매핑

- 해석자: 새 `ctb_interpreter` thread
- 판정자: 새 `ctb_judge` thread
- 지적 평가자: 새 `ctb_evaluator_critique` thread
- 고쳐쓰기 평가자: 새 `ctb_evaluator_rewrite` thread

해석자 2개와 판정자 3개를 가능한 한 같은 tool-call batch/launch wave에서 시작한다. 각 회차와 평가 단계마다 새 thread를 쓰며 thread를 재사용하지 않는다. 결과는 호스트의 협업 완료 통지로 받고 같은 대상을 반복 폴링하지 않는다.

## Codex 훅 경계

UserPromptSubmit 훅이 합성 체크리스트, 적용 경로, 역할 수, 회차 상한, `review-context.mjs --state ...` 명령을 제공한다. 평가자를 시작하기 직전에 그 명령을 실행하고 출력 원문과 실제 대화에서 확인한 작은 상태를 지적·고쳐쓰기 평가자에게 똑같이 전달한다. 명령 실패를 성공한 도구 근거로 바꾸지 않는다.

판정자 요약은 이 스킬 경로에서 두 디렉터리 위의 plugin root를 구해 `<plugin-root>/scripts/tally.mjs`에 넘긴다. 현재 작업 저장소나 설치 cache 경로를 추측하지 않는다.

Codex에는 Claude의 `tools: []`와 같은 일반 도구 allowlist가 없다. 역할 설정의 read-only·도구 금지 지시는 공격 표면을 줄일 뿐 완전한 도구 제거 증거가 아니다. 민감한 원문이나 저장소 내용을 역할 입력에 넣지 않는다.

Stop 훅은 공통 절차의 역할 수·launch wave·회차·평가 대상과 최종 출력 연결을 검사한다. 훅이 다시 작업을 요구하면 누락된 공통 절차를 채운다. 평가받은 초안과 같은 답만 허용한다.
