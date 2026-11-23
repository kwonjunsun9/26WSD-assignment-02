import { AppError, missing, forbidden, invalidState } from "./errors.js";

function withTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  return {
    // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
    // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
    apply(actor, eventId) {
      return withTransaction(repo.db, () => {
        if (!repo.event(eventId)) throw missing("행사");
        if (actor.role !== "STUDENT") throw forbidden();

        if (repo.existing(eventId, actor.id)) {
          throw new AppError(409, "ALREADY_APPLIED", "이미 신청한 행사입니다.");
        }

        const application = repo.insert(eventId, actor.id);
        repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: "APPLY",
          fromStatus: null,
          toStatus: application.status,
        });

        return application;
      });
    },
    // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
    // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
    cancel(actor, applicationId) {
      return withTransaction(repo.db, () => {
        const application = repo.application(applicationId);
        if (!application) throw missing("신청");

        if (actor.role !== "STUDENT" || application.userId !== actor.id) {
          throw forbidden();
        }

        if (application.status !== "PENDING") {
          throw invalidState();
        }

        const cancelled = repo.setStatus(application.id, "CANCELLED");
        repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: "CANCEL",
          fromStatus: application.status,
          toStatus: cancelled.status,
        });

        return cancelled;
      });
    },
    // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
    // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
    approve(actor, applicationId) {
      return withTransaction(repo.db, () => {
        const application = repo.application(applicationId);
        if (!application) throw missing("신청");

        const event = repo.event(application.eventId);
        if (actor.role !== "MANAGER" || event.managerId !== actor.id) {
          throw forbidden();
        }

        if (application.status !== "PENDING") {
          throw invalidState();
        }

        if (repo.approvedCount(event.id) >= event.capacity) {
          throw new AppError(409, "CAPACITY_FULL", "행사 정원이 찼습니다.");
        }
        const approved = repo.setStatus(application.id, "APPROVED");
        repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: "APPROVE",
          fromStatus: application.status,
          toStatus: approved.status,
        });

        return approved;
      });
    },
    // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
    // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
    // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
    // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
    // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
    revoke(actor, applicationId, reason) {
      return withTransaction(repo.db, () => {
        const application = repo.application(applicationId);
        if (!application) throw missing("신청");

        const event = repo.event(application.eventId);
        if (actor.role !== "MANAGER" || event.managerId !== actor.id) {
          throw forbidden();
        }

        if (application.status !== "APPROVED") {
          throw invalidState();
        }

        const revoked = repo.setStatus(application.id, "REVOKED");
        const causeHistoryId = repo.addHistory({
          applicationId: application.id,
          actorId: actor.id,
          action: "REVOKE",
          fromStatus: application.status,
          toStatus: revoked.status,
          reason,
        });

        const next = repo.nextPending(event.id);
        if (!next) return { revoked, promoted: null };

        const promoted = repo.setStatus(next.id, "APPROVED");
        repo.addHistory({
          applicationId: next.id,
          actorId: actor.id,
          action: "AUTO_APPROVE",
          fromStatus: next.status,
          toStatus: promoted.status,
          causeHistoryId,
        });

        return { revoked, promoted };
      });
    },
  };
}
