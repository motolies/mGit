import { RefLabels, refLabelItems } from '@mgit/graph-view';
import type { CommitDetail, SignatureStatus } from '@mgit/ipc';
import { formatCommitDate, S, shortHash } from '@mgit/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import styles from './CommitDetailView.module.css';
import { ContainingBranches, type ContainingLine } from './ContainingBranches';

/** "복사됨" 표시를 남겨 두는 시간 (ms) */
const COPIED_MS = 1200;

/** 커밋 메시지를 제목 한 줄과 본문으로 나눈다. 본문 앞의 빈 줄은 버린다 */
export function splitCommitMessage(message: string): { subject: string; body: string } {
  const idx = message.indexOf('\n');
  if (idx < 0) {
    return { subject: message, body: '' };
  }
  return { subject: message.slice(0, idx), body: message.slice(idx + 1).replace(/^\s*\n/, '') };
}

export interface CommitDetailViewProps {
  detail: CommitDetail;
  /** HEAD 가 이 커밋을 가리키는지. 분리 HEAD 면 ref 줄에 `HEAD` 라벨이 붙는다 */
  isHead: boolean;
  /** 상대 날짜의 기준 시각 (epoch ms). 주지 않으면 지금 */
  now?: number;
  /** 있으면 해시를 눌러 복사한다. 끝나면 잠깐 "복사됨" 을 보인다 */
  onCopyHash?: () => Promise<void>;
  /** 있으면 부모·자식 해시가 그 커밋으로 옮기는 링크가 된다. 없으면 글자만 보인다 */
  onNavigate?: (oid: string) => void;
  /** 서명 검증 결과. 있고 서명이 있으면(`N` 이 아니면) 한 줄로 보인다 */
  signature?: SignatureStatus | null;
  /** 맨 아래에 붙일 변경 파일 자리 (저장소 탭의 평면 목록). 폴더는 트리가 따로 있어 비운다 */
  files?: ReactNode;
  /**
   * 이 커밋을 포함하는 branch 줄 (CD-03). ref 라벨 줄 다음에 그린다. 컨테이너가 상세와 따로 뒤늦게 읽어
   * 넘기고, 주지 않으면 그리지 않는다
   */
  containing?: ContainingLine;
}

/** 해시 목록 (부모·자식): 이동할 수 있으면 링크 버튼, 아니면 고정폭 글자 */
function HashList({
  oids,
  onNavigate,
}: {
  oids: readonly string[];
  onNavigate?: (oid: string) => void;
}) {
  return (
    <>
      {oids.map((oid) =>
        onNavigate ? (
          <button
            key={oid}
            type="button"
            className={styles.link}
            title={oid}
            onClick={() => onNavigate(oid)}
          >
            {shortHash(oid)}
          </button>
        ) : (
          <span key={oid} className={styles.hashText} title={oid}>
            {shortHash(oid)}
          </span>
        ),
      )}
    </>
  );
}

/**
 * 커밋 상세 (CD-02): 제목(고정폭 굵게), 본문, `해시 작성자 <이메일> 날짜`, 커밋한 사람·시각(다를 때),
 * ref 라벨 줄(로그 행과 같은 모양), 포함 branch 줄(CD-03), 부모·자식, 서명. 스토어를 모르고 받은 값과 동작만 그린다 —
 * 주어지지 않은 동작(복사·이동)은 그리지 않는다. 폴더 탭과 저장소 탭이 함께 쓴다
 */
export function CommitDetailView({
  detail: d,
  isHead,
  now,
  onCopyHash,
  onNavigate,
  signature,
  files,
  containing,
}: CommitDetailViewProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 내려갈 때 "복사됨" 타이머를 정리한다
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  const { subject, body } = splitCommitMessage(d.message);
  const at = now ?? Date.now();
  const authored = formatCommitDate(d.authorTime, at, S.date);
  const committedDiffers = d.committerName !== d.authorName || d.committerTime !== d.authorTime;
  const labels = refLabelItems(d.refs, isHead);

  /** 해시를 복사하고 잠깐 표시한다. 실패는 조용히 넘긴다 (클립보드 권한 없음 등) */
  const copy = async () => {
    try {
      await onCopyHash?.();
      setCopied(true);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // 무시
    }
  };

  return (
    <div className={styles.view}>
      <div className={styles.subject}>{subject}</div>
      {body ? <pre className={styles.body}>{body}</pre> : null}
      <div className={styles.line}>
        {onCopyHash ? (
          <button
            type="button"
            className={styles.hash}
            title={`${d.oid}\n${S.detail.copyHash}`}
            onClick={() => void copy()}
          >
            {shortHash(d.oid)}
            {copied ? <span className={styles.copied}>{S.detail.copied}</span> : null}
          </button>
        ) : (
          <span className={styles.hashText} title={d.oid}>
            {shortHash(d.oid)}
          </span>
        )}
        <span className={styles.author}>{d.authorName}</span>
        <span className={styles.email}>&lt;{d.authorEmail}&gt;</span>
        <span className={styles.date}>{authored}</span>
      </div>
      {committedDiffers ? (
        <div className={styles.lineMuted} title={d.committerEmail}>
          {S.detail.committed(d.committerName, formatCommitDate(d.committerTime, at, S.date))}
        </div>
      ) : null}
      {labels.length > 0 ? (
        <div className={styles.refs}>
          <RefLabels items={labels} wrap />
        </div>
      ) : null}
      {containing ? (
        // 커밋이 바뀌면 펼침을 새로 시작한다
        <ContainingBranches key={d.oid} load={containing.load} onRetry={containing.onRetry} />
      ) : null}
      <dl className={styles.meta}>
        {d.parents.length > 0 ? (
          <>
            <dt>{S.detail.parents}</dt>
            <dd>
              <HashList oids={d.parents} onNavigate={onNavigate} />
            </dd>
          </>
        ) : null}
        {d.children.length > 0 ? (
          <>
            <dt>{S.detail.children}</dt>
            <dd>
              <HashList oids={d.children} onNavigate={onNavigate} />
            </dd>
          </>
        ) : null}
        {signature && signature.code !== 'N' ? (
          <>
            <dt>{S.detail.signature}</dt>
            <dd data-sig={signature.code} title={signature.key}>
              {S.detail.signatureCode(signature.code)}
              {signature.signer ? ` · ${signature.signer}` : ''}
            </dd>
          </>
        ) : null}
      </dl>
      {files}
    </div>
  );
}
