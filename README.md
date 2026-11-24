# 웹서비스 설계 과제 2 CAMPUS 신청 승인 서비스 

행사 신청, 학생의 대기 취소, 담당 운영자의 직접 승인, 승인 취소와 대기자 자동 승급을 구현하였습니다. 성공한 상태 변경은 행위자와 변경 전후 상태를 포함하여 이력으로 남깁니다. 서버는 Node.js와 Express로 실행하고, SQLite에 데이터와 이력을 저장하며 JWT로 사용자를 인증합니다.

## 설치와 실행

Node.js 24.x, npm을 사용합니다. 검증에는 Node.js v24.22.3을 사용하였습니다.

```sh
git clone https://github.com/kwonjunsun9/26WSD-assignment-02.git
cd 26WSD-assignment-02
node --version
npm ci
npm start
```

브라우저에서 [http://127.0.0.1:3000](http://127.0.0.1:3000)에 접속합니다. 첫 실행 시 `data/app.sqlite`와 `data/jwt-secret.txt`가 로컬에 생성됩니다. 의존성 설치에는 [package-lock.json](package-lock.json)을 사용합니다.

| 연습 계정 | 역할 |
| --- | --- |
| `alice`(민지), `bob`(준호), `charlie`(서연) | 학생 |
| `manager1`(운영자 A) | 행사 1 담당, 정원 2명 |
| `manager2`(운영자 B) | 행사 2 담당, 정원 1명 |

로그인 화면에서 연습 계정 버튼을 누르면 로그인 정보가 채워집니다. 이어서 로그인 버튼을 누릅니다.

### DB 초기화

`Ctrl+C`로 서버를 종료하고 저장소 최상위 폴더에서 아래 명령을 실행합니다. 확인 문구에 `RESET`을 입력하면 기존 신청과 변경 이력이 삭제되고 초기 연습 계정과 행사가 다시 생성됩니다. 초기화 후 `npm start`를 실행합니다.

```sh
npm run db:reset
```

재시작 후 상태 유지를 검증할 때는 같은 DB를 사용하고 서버를 종료한 뒤 `npm start`로 다시 실행합니다.

## 구현 완료 항목과 변경 파일

| 파일 | 변경 내용 |
| --- | --- |
| [src/application-service.js](src/application-service.js) | `apply()`, `cancel()`, `approve()`, `revoke()`의 권한·중복·상태·정원 검사를 구현하였습니다. `withTransaction()`으로 상태 변경과 이력을 함께 저장하고, 오류가 발생하면 전체를 롤백합니다. |
| [src/repository.js](src/repository.js) | `nextPending()`을 추가하였습니다. 같은 행사의 `PENDING` 신청을 `created_at`, `id` 오름차순으로 정렬하여 한 명을 선택합니다. |
| [concurrency-extra.mjs](concurrency-extra.mjs) | 같은 신청의 직접 승인과 대기 취소, 첫 대기자의 직접 승인과 기존 승인 취소를 각각 20회 검사하는 스크립트입니다. |

승인 취소는 `REVOKED` 상태와 `REVOKE` 이력을 저장한 뒤 대기자 한 명을 승급합니다. `AUTO_APPROVE` 이력에 원인 `REVOKE` 이력 ID를 연결하고, 대기자가 없으면 `promoted: null`을 반환합니다. 로그인·JWT 인증, 입력 검사, DB 스키마, 조회 API, 기본 화면과 제공 테스트를 사용하였습니다.

## 테스트와 증거

저장소 최상위 폴더에서 아래 명령을 실행합니다.

| 명령 | 확인 결과 |
| --- | --- |
| `npm test` | 기반 테스트 4건 통과 |
| `npm run test:assignment` | 필수 테스트 T01~T32 32건 통과 |
| `npm run test:advanced` | 서버 두 개에서 마지막 자리를 동시에 승인하는 검사를 20회 반복하여 통과 |
| `node --test concurrency-extra.mjs` | 추가 동시성 조합 2건을 각각 20회 반복하여 통과 |

- 필수 테스트 터미널 캡처 [T01~T08](docs/evidence/T01~T08.png) · [T09~T16](docs/evidence/T09~T16.png) · [T17~T24](docs/evidence/T17~T24.png) · [T25~T32](docs/evidence/T25~T32.png)
- T29에서는 `AUTO_APPROVE` 이력 저장 오류에 `500 INTERNAL_ERROR`가 반환되고 두 신청 상태와 기존 이력 3건이 유지되었습니다. 트리거를 제거한 뒤 재시도에서 `HTTP 200`, 승인 취소와 자동 승급, 이력 2건 추가를 확인하였습니다. [T29 전후 비교와 재시도](docs/evidence/T29%20자동승급이력%20저장%20실패.png)

| 화면 검증 | 결과와 증거 |
| --- | --- |
| U01 | 학생 신청, 담당 운영자 승인, 학생의 상태 재조회 확인. [U01](docs/evidence/U01) |
| U02 | 대기 취소와 `CANCELLED` 이력을 확인하였습니다. 이전 운영자 화면의 승인 요청 `409 INVALID_STATE` 응답 캡처는 보류 상태입니다. [U02](docs/evidence/U02) |
| U03 | 서버 종료와 재실행 후 신청 상태 및 변경 이력 유지 확인. [U03](docs/evidence/U03) |
| U04 | 첫 대기자 승급, 승인 인원 유지, 두 신청의 원인 이력 연결 확인. [U04](docs/evidence/U04) |
| U05 | 민지의 `REVOKED` 상태와 승인 인원 0명을 확인하였습니다. 취소 응답의 `"promoted": null` 화면 캡처는 보류 상태입니다. [U05](docs/evidence/U05) |

동시성 검사에서는 두 서버가 같은 임시 SQLite DB를 사용합니다. 서비스는 `BEGIN IMMEDIATE`로 쓰기 트랜잭션을 시작하고 현재 상태와 정원 확인을 저장 작업과 함께 처리합니다. 검증 범위는 세 요청 조합을 각각 20회 반복한 경우입니다.

## 보고서와 참고 자료

- [구현 및 검증 보고서 PDF](docs/%EC%9B%B9%EC%84%9C%EB%B9%84%EC%8A%A4%EC%84%A4%EA%B3%84%20%EA%B3%BC%EC%A0%9C2%20%EB%B3%B4%EA%B3%A0%EC%84%9C%20-%20202219348%20%EA%B6%8C%EC%A4%80%EC%84%B1.pdf)
- [과제 2 안내문](docs/01_과제2_안내문.pdf)
- [API 계약](docs/API.md)
- [전체 검증 증거](docs/evidence)

코드 흐름 분석과 테스트 실행·결과 정리, 추가 동시성 검증 스크립트에 ChatGPT를 활용하였습니다.
로컬에서 필수 테스트와 T29 롤백 및 재시도, 기본·추가 동시성 테스트를 직접 검증하였으며, 구체적인 적용 위치와 결과는 보고서의 AI 활용 항목에 기록하였습니다.
