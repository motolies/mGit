import { describe, expect, it } from 'vitest';
import { ko } from '../i18n/ko';

describe('한국어 UI 문구 계약', () => {
  it('기본 Git 개념과 불러오기 상태를 같은 용어로 표시한다', () => {
    expect(ko.status.loaded(12_345)).toBe('커밋 12,345개');
    expect(ko.filterBar.branch).toBe('브랜치');
    expect(ko.menu.checkout).toBe('브랜치 전환');
    expect(ko.menu.checkoutDetached).toBe('이 커밋으로 전환 (분리된 HEAD)');
    expect(ko.status.op.merge).toBe('병합 중');
    expect(ko.status.op.rebase(2, 3)).toBe('리베이스 중 2/3');
    expect(ko.project.loading).toBe('불러오는 중…');
    expect(ko.fileView.loading).toBe('불러오는 중…');
    expect(ko.commitTool.check.checked).toContain('스테이징됨');
  });

  it('실제 명령·옵션·설정 키·참조 식별자는 번역하지 않는다', () => {
    expect(ko.remote.pullMode.merge).toBe('pull --no-rebase');
    expect(ko.remote.pullMode.rebase).toBe('pull --rebase');
    expect(ko.remote.pullMode.ffOnly).toBe('pull --ff-only');
    expect(ko.dnd.mergeNoFf).toBe('merge --no-ff');
    expect(ko.stash.name(3)).toBe('stash@{3}');
    expect(ko.error.gitFailed(['push', '--force-with-lease'], '')).toBe(
      'git push --force-with-lease 실패',
    );
    expect(ko.repoSettings.signingInfo('ssh', 'test-key', true)).toContain('commit.gpgSign');
  });

  it('프로젝트 이름·원격·파일 경로를 보존하고 서비스별 요청 이름을 구분한다', () => {
    const name = 'feature/한글-[1]';
    const remote = 'upstream/company';
    const pushed = ko.tag.pushed(name, remote);
    expect(pushed).toContain(name);
    expect(pushed).toContain(remote);
    expect(ko.history.blameTitle('src/한글 파일.java')).toContain('src/한글 파일.java');
    expect(ko.pr.title('gitlab')).toBe('병합 요청');
    expect(ko.pr.title('github')).toBe('풀 리퀘스트');
    expect(ko.pr.review('custom-review-state')).toBe('custom-review-state');
  });
});
