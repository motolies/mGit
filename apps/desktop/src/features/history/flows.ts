import { S } from '@mgit/ui';
import { bool, str, type useDialogs } from '../../components/use-dialogs';
import { headBranchOf, type SessionState } from '../../store';
import { LOCAL } from './comparison';

type Dialogs = ReturnType<typeof useDialogs>;

/** 두 ref 비교 입력 (DIFF-06): A·B 를 고르고 공통 조상 기준 여부 */
export async function compareFlow(
  dialogs: Dialogs,
  st: Pick<SessionState, 'refs' | 'openCompare'>,
): Promise<void> {
  const head = headBranchOf(st.refs) ?? 'HEAD';
  const names = [...new Set(['HEAD', ...st.refs.labels.map((l) => l.shortName)])];
  const options = names.map((v) => ({ value: v, label: v }));
  const other = names.find((n) => n !== head) ?? head;
  const v = await dialogs.prompt({
    title: S.history.compareTitle,
    fields: [
      { key: 'a', label: S.history.compareA, type: 'select', initial: head, options },
      {
        key: 'b',
        label: S.history.compareB,
        type: 'select',
        initial: other,
        options: [...options, { value: LOCAL, label: S.comparison.localContent }],
      },
      { key: 'threeDot', label: S.history.threeDot, type: 'checkbox', initial: false },
    ],
    confirmLabel: S.history.compareRun,
  });
  if (v) {
    await st.openCompare(str(v, 'a'), str(v, 'b'), bool(v, 'threeDot'));
  }
}

/** 그래프 열 설정 (GRAPH-12) */
export async function columnsFlow(
  dialogs: Dialogs,
  st: Pick<SessionState, 'graphColumns' | 'setGraphColumns'>,
): Promise<void> {
  const c = st.graphColumns;
  const v = await dialogs.prompt({
    title: S.graph.filter.columnsTitle,
    fields: [
      { key: 'author', label: S.graph.columns.author, type: 'checkbox', initial: c.author },
      { key: 'date', label: S.graph.columns.date, type: 'checkbox', initial: c.date },
      { key: 'hash', label: S.graph.columns.hash, type: 'checkbox', initial: c.hash },
      { key: 'avatar', label: S.graph.filter.avatar, type: 'checkbox', initial: c.avatar ?? false },
    ],
    confirmLabel: S.dialog.apply,
  });
  if (v) {
    st.setGraphColumns({
      author: bool(v, 'author'),
      date: bool(v, 'date'),
      hash: bool(v, 'hash'),
      avatar: bool(v, 'avatar'),
    });
  }
}
