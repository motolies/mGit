import { createContext } from 'react';
import type { Action } from '../actions';

/**
 * 본문(워크스페이스·터미널)에 넘기는 동작 출처 (D-3). 동작 목록은 쓰기 동작의 시작·끝(busy)·dock 토글마다 활성 여부가 바뀌어
 * 새로 만들어진다. 목록을 그대로 넘기면 받는 본문 전체(워크스페이스·Git 도구 창)가 그때마다 다시 그려지므로, 본문에는
 * 활성 여부와 무관한 것만 안정된 참조로 넘긴다 — 그리는 데 쓰는 안내 글자·링크와, 실행할 때 지금 목록을 읽는 `current`.
 * 활성 여부를 그리는 화면(툴바·팔레트·단축키 처리기)은 동작 목록을 직접 받는다
 */
export interface CommandSource {
  /** 지금의 동작 목록. 키를 누르거나 링크를 누른 그때 부른다 (객체가 그대로여도 늘 최신이다) */
  current(): readonly Action[];
  /** 빈 에디터 공간의 단축키 안내 (제목·단축키가 바뀔 때만 새로 만든다) */
  hints: readonly { label: string; shortcut: string | undefined }[];
  /** 저장소 탭 빈 에디터 공간의 "tag 관리 열기" 링크 (그 동작이 켜져 있을 때만) */
  tagsDoc: { label: string; onClick: () => void } | undefined;
}

/** 동작이 없는 출처 (공급자 밖 — 시험에서 터미널만 그릴 때 등) */
const EMPTY_SOURCE: CommandSource = { current: () => [], hints: [], tagsDoc: undefined };

/** 터미널·워크스페이스 같은 공유 셸 UI에 동작 출처를 전달한다 */
export const CommandContext = createContext<CommandSource>(EMPTY_SOURCE);
