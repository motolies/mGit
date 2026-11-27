import { history } from '@codemirror/commands';
import { Compartment, EditorState } from '@codemirror/state';
import type { FsEditableFile, FsEncoding, IpcClient, SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describeError } from './errors';

export type EditorStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
export interface EditorSource {
  session: SessionId;
  path: string;
  client: IpcClient;
  onDirty?: () => void;
  onSaved?: () => void;
}
export interface EditorFile {
  fileKey: string;
  path: string;
  revision: string;
  state: EditorState;
  baseText: string;
  bom: boolean;
  lineEnding: 'lf' | 'crlf';
  /** 원문의 인코딩 (R2). 저장 때 코어가 이 인코딩으로 다시 쓴다 */
  encoding: FsEncoding;
  /** BOM 없이 UTF-8 이 아니어서 코어가 후보 중에서 고른 인코딩인지 */
  guessed: boolean;
  /** 사용자가 고른 인코딩 (다시 읽을 때 이 인코딩으로 읽는다). 고르지 않았으면 null — 코어가 정한다 */
  readAs: FsEncoding | null;
  dirty: boolean;
  status: EditorStatus;
  error: string | null;
  sequence: number;
  generation: number;
  /** 미리보기가 그림 파일 표지를 다시 확인할 신호 (검사·원문 교체마다 오른다 — 바뀐 그림만 다시 읽는다) */
  imageEpoch: number;
  composing: boolean;
  mutationLocked?: boolean;
  scrollTop: number;
  scrollLeft: number;
  wrap: boolean;
  language: Compartment;
  controls: Compartment;
  annotations: Compartment;
  revealPosition?: number;
  revealFocus?: { session: SessionId; path: string };
  explicitSave?: () => Promise<boolean>;
  sources: Map<string, EditorSource>;
  timer?: ReturnType<typeof setTimeout>;
  inflight?: Promise<boolean>;
  readSequence: number;
  /** 마지막 변경 검사 때 본 파일 표지 (`fsFileStamps`). 같으면 원문을 다시 읽지 않는다 (N6) */
  stamp?: string | null;
  /**
   * 창 포커스 복귀 때 보이지 않아 원문을 강제로 읽지 않은 문서다 (G4). 다시 보이게 되면(편집기·미리보기가 구독하면) 그때
   * 원문을 읽는다 — 표지 정밀도가 낮은 파일 시스템의 안전망을 보이기 전에 채운다
   */
  recheckOnShow?: boolean;
}

/** 변경 검사 방식: 표지가 같은 파일은 건너뛴다 / 모두 원문을 읽는다 (창 포커스) */
export interface RefreshOptions {
  force?: boolean;
}
export type EditorOpenResult = EditorFile | Exclude<FsEditableFile, { kind: 'text' }>;

/** 세션 안 상대 경로를 충돌 없이 식별한다. */
function sourceKey(session: SessionId, path: string): string {
  return JSON.stringify([session, path]);
}

/**
 * 편집 조회 (R2). 고른 인코딩이 있으면 그 인코딩으로 읽고, 없으면 예전처럼 인자 둘로 불러 코어가 정하게 한다 (BOM·UTF-8·
 * 후보 차례)
 */
export function readEditable(
  client: IpcClient,
  session: SessionId,
  path: string,
  encoding: FsEncoding | null,
): Promise<FsEditableFile> {
  return encoding === null
    ? client.fsReadEditableFile(session, path)
    : client.fsReadEditableFile(session, path, encoding);
}

/** 편집 조회 결과의 인코딩 (예전 응답·목에는 없다 — UTF-8) */
export function encodingOf(file: { encoding?: FsEncoding | null }): FsEncoding {
  return file.encoding ?? 'utf8';
}

/** BOM을 편집기 밖에 보관하고 줄 끝은 내부 LF로 표현한다. */
function editorText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** 화면 초안을 원래 BOM과 줄 끝으로 직렬화한다. */
export function fileText(doc: EditorFile): string {
  const body = doc.state.doc.toString();
  return `${doc.bom ? '\uFEFF' : ''}${doc.lineEnding === 'crlf' ? body.replace(/\n/g, '\r\n') : body}`;
}

/** 구독자 묶음 하나 (주제 하나). 알림은 등록한 차례로 부른다 */
class Signal {
  private listeners = new Set<() => void>();

  /** 구독하고 해제 함수를 준다 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 구독자를 모두 부른다 */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 구독자 수 */
  get size(): number {
    return this.listeners.size;
  }
}

/** 탭 표시에 쓰는 문서 상태: 저장 안 됨(초안·저장 중), 디스크 충돌, 저장·읽기 오류. 깨끗하면 표시 없음 */
export type EditorMark = 'unsaved' | 'conflict' | 'error';

/** 문서의 탭 표시 상태 (깨끗하면 null). 저장 대기·저장 중 사이의 전환은 같은 'unsaved' 다 */
function markOf(doc: EditorFile): EditorMark | null {
  if (doc.status === 'conflict') return 'conflict';
  if (doc.status === 'error') return 'error';
  return doc.dirty || doc.inflight ? 'unsaved' : null;
}

/**
 * 탭 생명주기와 분리된 편집 상태. 같은 실제 경로는 하나의 초안과 저장 큐를 공유한다.
 *
 * 알림은 주제별로 나눈다 (반응성 F1). 바뀐 것이 없는 검사(2초 주기·창 포커스·세션 갱신)는 아무도 깨우지 않는다.
 * - 문서 주제(`subscribeDoc`): 그 문서의 초안·상태·별칭이 바뀔 때. 그 문서를 그리는 편집기가 듣는다
 * - 그림 재확인 주제(`subscribeImage`): 검사마다 `imageEpoch` 가 오를 때. 그 문서의 미리보기만 듣는다
 * - 표시 주제(`subscribeMarks`): 별칭별 탭 표시(`marks`)가 바뀔 때만. 워크스페이스 탭의 ● 가 듣는다 — 이미 저장 안 된
 *   문서에 글자를 더해도 알리지 않는다
 * - 전체 주제(`subscribe`): 어느 문서든 실제로 바뀔 때. 선택자로 좁혀 듣는다 (별칭·초안 지문 등)
 */
export class FileEditorStore {
  private files = new Map<string, EditorFile>();
  private aliases = new Map<string, EditorFile>();
  private opening = new Map<string, Promise<EditorOpenResult>>();
  /** 세션 안 경로마다 사용자가 고른 인코딩 (R2). 탭을 닫았다 다시 열어도 세션이 끝날 때까지 남는다 */
  private encodings = new Map<string, FsEncoding>();
  private changed = new Signal();
  private version = 0;
  private docSignals = new WeakMap<EditorFile, Signal>();
  private docVersions = new WeakMap<EditorFile, number>();
  private imageSignals = new WeakMap<EditorFile, Signal>();
  private imageAny = new Signal();
  private marksSignal = new Signal();
  private marksMap: ReadonlyMap<string, EditorMark> = new Map();
  private marksKey = '';

  /** 어느 문서든 실제로 바뀌면 알린다 (선택자로 좁혀 쓴다). 바뀐 것이 없는 검사에는 알리지 않는다 */
  subscribe = (listener: () => void): (() => void) => this.changed.subscribe(listener);

  /** 전체 주제의 버전 (실제 변경마다 오른다) */
  getVersion = (): number => this.version;

  /** 한 문서의 변화(초안·상태·별칭·위치 요청)를 구독한다. 그 문서를 그리는 편집기가 듣는다 — 보이는 문서의 표시다 */
  subscribeDoc = (doc: EditorFile, listener: () => void): (() => void) => {
    const off = this.signalOf(this.docSignals, doc).subscribe(listener);
    this.recheckShown(doc);
    return off;
  };

  /** 한 문서의 버전 (그 문서가 바뀔 때마다 오른다 — 문서 객체는 같은 참조로 바뀌므로 이 값으로 견준다) */
  docVersion = (doc: EditorFile): number => this.docVersions.get(doc) ?? 0;

  /** 한 문서의 그림 재확인 신호(`imageEpoch`)를 구독한다 (미리보기가 듣는다 — 보이는 문서의 표시다) */
  subscribeImage = (doc: EditorFile, listener: () => void): (() => void) => {
    const off = this.signalOf(this.imageSignals, doc).subscribe(listener);
    this.recheckShown(doc);
    return off;
  };

  /** 지금 그 문서를 그리는 화면(편집기·미리보기)이 있는지 */
  private shown(doc: EditorFile): boolean {
    return (this.docSignals.get(doc)?.size ?? 0) > 0 || (this.imageSignals.get(doc)?.size ?? 0) > 0;
  }

  /**
   * 포커스 복귀 때 강제로 읽지 못한(보이지 않던) 문서가 보이게 되면 원문을 읽는다 (G4). 구독 도중에 알리지 않게 다음
   * 마이크로태스크로 미룬다
   */
  private recheckShown(doc: EditorFile): void {
    if (!doc.recheckOnShow) return;
    doc.recheckOnShow = false;
    queueMicrotask(() => void this.refresh(doc));
  }

  /** 모든 문서의 그림 재확인 신호 (측정용 — 성능 기록기가 센다) */
  subscribeImages = (listener: () => void): (() => void) => this.imageAny.subscribe(listener);

  /** 별칭별 탭 표시가 바뀔 때만 알린다 */
  subscribeMarks = (listener: () => void): (() => void) => this.marksSignal.subscribe(listener);

  /** 별칭(`[세션, 경로]` 의 JSON) → 탭 표시. 표시가 없는 별칭은 없다. 바뀔 때만 새 객체다 */
  marks = (): ReadonlyMap<string, EditorMark> => this.marksMap;

  /** 세션 하나의 탭 표시를 값으로 견줄 수 있는 문자열로 준다 (같으면 같은 문자열) */
  marksOf = (session: SessionId): string => {
    const parts: string[] = [];
    for (const [key, mark] of this.marksMap) {
      const [owner, path] = JSON.parse(key) as [SessionId, string];
      if (owner === session) parts.push(`${path}\u0000${mark}`);
    }
    return parts.join('\u0001');
  };

  /** 문서별 구독자 묶음을 꺼낸다 (없으면 만든다) */
  private signalOf(map: WeakMap<EditorFile, Signal>, doc: EditorFile): Signal {
    let signal = map.get(doc);
    if (!signal) {
      signal = new Signal();
      map.set(doc, signal);
    }
    return signal;
  }

  /**
   * 실제 변경을 알린다: 바뀐 문서의 구독자 → 전체 구독자 → (탭 표시가 달라졌으면) 표시 구독자. `docs` 는 이번에 바뀐 문서들
   * (별칭만 바뀐 경우도 그 문서). 문서와 무관한 변경(고른 인코딩)은 비워 부른다
   */
  private emit(...docs: EditorFile[]): void {
    this.version += 1;
    for (const doc of new Set(docs)) {
      this.docVersions.set(doc, this.docVersion(doc) + 1);
      this.docSignals.get(doc)?.notify();
    }
    this.changed.notify();
    this.updateMarks();
  }

  /** 그림 재확인 신호만 올린다 — 그 문서의 미리보기만 깨운다 (원문·상태는 그대로) */
  private bumpImage(doc: EditorFile): void {
    doc.imageEpoch += 1;
    this.imageSignals.get(doc)?.notify();
    this.imageAny.notify();
  }

  /** 탭 표시를 다시 계산해 달라졌을 때만 표시 구독자에게 알린다 */
  private updateMarks(): void {
    const next = new Map<string, EditorMark>();
    for (const doc of this.files.values()) {
      const mark = markOf(doc);
      if (mark === null) continue;
      for (const key of doc.sources.keys()) next.set(key, mark);
    }
    const key = [...next]
      .map(([alias, mark]) => `${alias}\u0000${mark}`)
      .sort()
      .join('\u0001');
    if (key === this.marksKey) return;
    this.marksKey = key;
    this.marksMap = next;
    this.marksSignal.notify();
  }

  /** 세션의 상대 경로로 공유 문서를 찾는다. */
  get(session: SessionId, path: string): EditorFile | undefined {
    return this.aliases.get(sourceKey(session, path));
  }

  /** 구조 변경 전에 이미 시작된 파일 열기를 모두 완료한다. */
  async settleOpening(): Promise<void> {
    await Promise.allSettled([...this.opening.values()]);
  }

  /** 선택한 세션과 경로가 참조하는 문서를 중복 없이 고른다. */
  documents(session?: SessionId, path?: string): EditorFile[] {
    return [...this.files.values()].filter((doc) =>
      [...doc.sources.values()].some(
        (source) =>
          (session === undefined || source.session === session) &&
          (path === undefined || source.path === path),
      ),
    );
  }

  /** 검색 결과의 위치를 공유 문서와 실제 화면에 전달한다. */
  reveal(doc: EditorFile, position: number, focus?: { session: SessionId; path: string }): void {
    const anchor = Math.max(0, Math.min(position, doc.state.doc.length));
    doc.state = doc.state.update({ selection: { anchor } }).state;
    doc.revealPosition = anchor;
    if (focus) doc.revealFocus = focus;
    this.emit(doc);
  }

  /** 저장할 초안이나 진행 중 저장이 있는지 확인한다. */
  hasDirty(session?: SessionId, path?: string): boolean {
    return this.documents(session, path).some((doc) => doc.dirty || !!doc.inflight);
  }

  /** 파일을 읽어 실제 식별자로 합친다. 같은 경로의 동시 열기는 읽기 하나를 공유한다. */
  async open(
    client: IpcClient,
    session: SessionId,
    path: string,
    hooks: Pick<EditorSource, 'onDirty' | 'onSaved'> = {},
  ): Promise<EditorOpenResult> {
    const key = sourceKey(session, path);
    const source = { client, session, path, ...hooks };
    const existing = this.aliases.get(key);
    if (existing) {
      existing.sources.set(key, source);
      return existing;
    }
    const pending = this.opening.get(key);
    if (pending) return pending;
    const readAs = this.encodings.get(key) ?? null;
    const request = (async () => {
      const file = await readEditable(client, session, path, readAs);
      if (file.kind !== 'text') return file;
      let doc = this.files.get(file.fileKey);
      // 다른 탭이 같은 파일을 다른 인코딩으로 열어 두었으면(R2) 깨끗할 때 이번 원문으로 바꾼다 — 같은 파일은 한 문서다
      if (
        doc &&
        (doc.encoding !== encodingOf(file) || doc.readAs !== readAs) &&
        !doc.dirty &&
        !doc.inflight
      ) {
        this.replace(doc, file);
        doc.readAs = readAs;
      }
      if (!doc) {
        const language = new Compartment();
        const controls = new Compartment();
        const annotations = new Compartment();
        doc = {
          fileKey: file.fileKey,
          path,
          revision: file.revision,
          state: EditorState.create({
            doc: editorText(file.text),
            extensions: [history(), language.of([]), controls.of([]), annotations.of([])],
          }),
          baseText: file.text,
          bom: file.bom,
          lineEnding: file.lineEnding,
          encoding: encodingOf(file),
          guessed: file.guessed === true,
          readAs,
          dirty: false,
          status: 'saved',
          error: null,
          sequence: 0,
          generation: 0,
          imageEpoch: 0,
          composing: false,
          scrollTop: 0,
          scrollLeft: 0,
          wrap: false,
          language,
          controls,
          annotations,
          sources: new Map(),
          readSequence: 0,
        };
        this.files.set(file.fileKey, doc);
      }
      doc.sources.set(key, source);
      this.aliases.set(key, doc);
      this.emit(doc);
      return doc;
    })();
    this.opening.set(key, request);
    try {
      return await request;
    } finally {
      this.opening.delete(key);
    }
  }

  /** 편집 상태 전체를 기억하며 텍스트 변경에만 저장 예약과 미리보기 고정을 적용한다. */
  update(doc: EditorFile, state: EditorState): void {
    if (doc.mutationLocked) return;
    const changed = state.doc !== doc.state.doc;
    doc.state = state;
    if (!changed) return;
    doc.sequence += 1;
    doc.dirty = fileText(doc) !== doc.baseText;
    for (const source of doc.sources.values()) {
      try {
        source.onDirty?.();
      } catch {
        /* 화면 고정 실패가 초안 저장을 중단하지 않게 한다. */
      }
    }
    if (doc.status !== 'conflict' && doc.status !== 'error') {
      doc.status = doc.inflight ? 'saving' : doc.dirty ? 'pending' : 'saved';
      this.schedule(doc);
    }
    this.emit(doc);
  }

  /** 입력이 멈춘 뒤 1초에 저장하고 조합 중에는 타이머를 만들지 않는다. */
  private schedule(doc: EditorFile): void {
    clearTimeout(doc.timer);
    doc.timer = undefined;
    if (
      doc.mutationLocked ||
      !doc.dirty ||
      doc.composing ||
      doc.status === 'conflict' ||
      doc.status === 'error'
    )
      return;
    doc.timer = setTimeout(() => {
      doc.timer = undefined;
      void this.save(doc);
    }, 1000);
  }

  /** 한글 조합 시작은 저장을 미루고 완료 후 마지막 입력부터 시간을 센다. */
  composition(doc: EditorFile, composing: boolean): void {
    doc.composing = composing;
    this.schedule(doc);
    this.emit(doc);
  }

  /** 저장 요청을 하나만 보내고 늦은 응답은 최신 초안을 변경하지 않는다. */
  async save(doc: EditorFile): Promise<boolean> {
    if (doc.mutationLocked) return false;
    clearTimeout(doc.timer);
    doc.timer = undefined;
    if (doc.inflight) return doc.inflight;
    if (!doc.dirty) return true;
    if (doc.composing || doc.status === 'conflict') return false;
    const source = doc.sources.values().next().value as EditorSource | undefined;
    if (!source) return false;
    const text = fileText(doc);
    const revision = doc.revision;
    const encoding = doc.encoding;
    doc.status = 'saving';
    doc.error = null;
    this.emit(doc);
    doc.inflight = (async () => {
      try {
        // UTF-8 이 아니면 코어가 같은 인코딩으로 다시 써서 저장한다 (R2). UTF-8 은 예전처럼 인자 넷이다
        const result =
          encoding === 'utf8'
            ? await source.client.fsSaveFile(source.session, source.path, revision, text)
            : await source.client.fsSaveFile(source.session, source.path, revision, text, encoding);
        if (result.kind === 'conflict') {
          doc.status = 'conflict';
          return false;
        }
        if (result.kind === 'failed') {
          doc.status = 'error';
          doc.error = result.message;
          return false;
        }
        doc.revision = result.revision;
        doc.baseText = text;
        doc.dirty = fileText(doc) !== text;
        doc.status = doc.dirty ? 'pending' : 'saved';
        for (const item of doc.sources.values()) {
          try {
            item.onSaved?.();
          } catch {
            /* 저장 완료와 화면 갱신 실패는 분리한다. */
          }
        }
        return true;
      } catch (error) {
        doc.status = 'error';
        doc.error = describeError(error);
        return false;
      } finally {
        doc.inflight = undefined;
        this.schedule(doc);
        this.emit(doc);
      }
    })();
    return doc.inflight;
  }

  /** 닫기 전에 저장 중 추가된 입력까지 모두 반영한다. 실패나 조합 중이면 닫지 않는다. */
  async flush(session?: SessionId, path?: string): Promise<boolean> {
    for (const doc of this.documents(session, path)) {
      do {
        if (!(await this.save(doc))) return false;
      } while (doc.dirty || doc.inflight);
    }
    return true;
  }

  /** 디스크 변경을 검사한다. 저장 중 읽기는 저장 응답 뒤에 시작해 자기 저장과 경합하지 않는다. */
  async refresh(doc: EditorFile): Promise<void> {
    if (doc.mutationLocked) return;
    // 원문을 읽으므로 보일 때의 재검사(G4)도 채운다
    doc.recheckOnShow = false;
    // 그림 미리보기만 다시 확인하게 한다. 원문이 그대로면 아래에서 아무도 깨우지 않는다 (F1)
    this.bumpImage(doc);
    if (doc.inflight) await doc.inflight;
    const source = doc.sources.values().next().value as EditorSource | undefined;
    if (!source) return;
    const read = ++doc.readSequence;
    const revision = doc.revision;
    try {
      const file = await readEditable(source.client, source.session, source.path, doc.readAs);
      if (read !== doc.readSequence || revision !== doc.revision || doc.inflight) return;
      if (file.kind === 'text' && file.revision === doc.revision) return;
      if (doc.dirty || doc.composing) {
        clearTimeout(doc.timer);
        doc.status = 'conflict';
        doc.error = null;
      } else if (file.kind === 'text') {
        this.replace(doc, file);
      } else {
        doc.status = 'conflict';
        doc.error = S.fileEditor.unreadable;
      }
      this.emit(doc);
    } catch (error) {
      if (read !== doc.readSequence || revision !== doc.revision || doc.inflight) return;
      doc.error = describeError(error);
      doc.status = doc.dirty ? 'conflict' : 'error';
      clearTimeout(doc.timer);
      this.emit(doc);
    }
  }

  /** 해당 세션의 비활성 탭까지 외부 변경을 확인한다 (표지를 먼저 본다) */
  async refreshSession(session: SessionId, options: RefreshOptions = {}): Promise<void> {
    await this.refreshDocs(this.documents(session), options);
  }

  /** 열린 모든 파일의 외부 변경을 확인한다 (2초 주기는 표지를 먼저 본다. `force` 면 모두 원문을 읽는다) */
  async refreshAll(options: RefreshOptions = {}): Promise<void> {
    await this.refreshDocs([...this.files.values()], options);
  }

  /**
   * 창 포커스 복귀: 지금 보이는 문서(편집기·미리보기가 그리는 것)는 표지 없이 원문을 읽는다 — 시각 정밀도가 낮은 파일
   * 시스템에서 표지가 그대로여도 바뀐 내용을 놓치지 않는 안전망이다 (G4, 예전에는 열린 파일 전부를 이렇게 읽었다)
   */
  async refreshShown(): Promise<void> {
    await this.refreshDocs(
      [...this.files.values()].filter((doc) => this.shown(doc)),
      { force: true },
    );
  }

  /**
   * 창 포커스 복귀: 보이지 않는 문서는 표지로 검사하고(바뀐 것만 원문을 읽는다), 다시 보이게 될 때 원문을 한 번 읽도록
   * 표시해 둔다 (`recheckOnShow`). 안전망은 그대로이고 보이기 전까지 미룰 뿐이다 (G4)
   */
  async refreshHidden(): Promise<void> {
    const hidden = [...this.files.values()].filter((doc) => !this.shown(doc));
    for (const doc of hidden) doc.recheckOnShow = true;
    await this.refreshDocs(hidden, {});
  }

  /**
   * 변경 검사 (N6): 문서를 처음 소스의 세션별로 묶어 파일 표지를 한 번에 묻고, 지난 검사와 표지가 같은 문서는 원문을
   * 다시 읽지 않는다 — 측정상 열린 파일 30개 × 900 KiB 에서 원문 읽기·해시 17 ms + 응답 12 MiB 가 표지 0.5 ms 로 준다.
   * 표지가 다르거나 모르면(null·조회 실패) 예전처럼 원문을 읽는다. 건너뛴 문서도 미리보기가 그림 표지를 다시 확인하게
   * 둔다(`imageEpoch` → 미리보기의 `checkKey`, 바뀐 그림만 다시 읽는다). `force` 면 표지 없이 모두 읽는다 — 시각 정밀도가
   * 낮은 파일 시스템의 안전망이다
   */
  private async refreshDocs(docs: readonly EditorFile[], options: RefreshOptions): Promise<void> {
    if (options.force) {
      await Promise.all(docs.map((doc) => this.refresh(doc)));
      return;
    }
    const groups = new Map<SessionId, { source: EditorSource; docs: EditorFile[] }>();
    for (const doc of docs) {
      const source = doc.sources.values().next().value as EditorSource | undefined;
      if (!source) continue;
      const group = groups.get(source.session) ?? { source, docs: [] };
      group.docs.push(doc);
      groups.set(source.session, group);
    }
    await Promise.all(
      [...groups.values()].map(async ({ source, docs: members }) => {
        const paths = members.map(
          (doc) => (doc.sources.values().next().value as EditorSource).path,
        );
        const stamps = await source.client
          .fsFileStamps(source.session, paths)
          .catch(() => paths.map(() => null));
        await Promise.all(
          members.map((doc, i) => {
            const stamp = stamps[i] ?? null;
            if (stamp !== null && doc.stamp === stamp && !doc.inflight && !doc.mutationLocked) {
              // 표지가 같으면 원문·상태가 그대로다 — 그림 미리보기만 다시 확인하게 하고 아무도 깨우지 않는다 (F1)
              this.bumpImage(doc);
              return Promise.resolve();
            }
            doc.stamp = stamp;
            return this.refresh(doc);
          }),
        );
      }),
    );
  }

  /** 확인된 새 원문으로 편집기 상태를 초기화한다. */
  private replace(doc: EditorFile, file: Extract<FsEditableFile, { kind: 'text' }>): void {
    doc.state = EditorState.create({
      doc: editorText(file.text),
      extensions: [history(), doc.language.of([]), doc.controls.of([]), doc.annotations.of([])],
    });
    doc.revision = file.revision;
    doc.baseText = file.text;
    doc.bom = file.bom;
    doc.lineEnding = file.lineEnding;
    doc.encoding = encodingOf(file);
    doc.guessed = file.guessed === true;
    doc.dirty = false;
    doc.status = 'saved';
    doc.error = null;
    doc.sequence += 1;
    doc.generation += 1;
    doc.imageEpoch += 1;
  }

  /** 사용자가 폐기를 확인한 경우에만 디스크 내용으로 되돌린다. */
  async reload(doc: EditorFile): Promise<void> {
    const sequence = doc.sequence;
    if (doc.inflight) await doc.inflight;
    const source = doc.sources.values().next().value as EditorSource | undefined;
    if (!source) return;
    try {
      const file = await readEditable(source.client, source.session, source.path, doc.readAs);
      if (file.kind !== 'text') throw new Error(S.fileEditor.reloadUnreadable);
      if (sequence !== doc.sequence) throw new Error(S.fileEditor.editedSinceConfirm);
      clearTimeout(doc.timer);
      this.replace(doc, file);
    } catch (error) {
      doc.status = 'conflict';
      doc.error = describeError(error);
    }
    this.emit(doc);
  }

  /** 파일 교체 후 텍스트 문서를 다시 읽고 비텍스트가 되었으면 별칭을 해제해 일반 뷰로 돌아간다. */
  async reloadAfterReplacement(doc: EditorFile): Promise<void> {
    const source = doc.sources.values().next().value as EditorSource | undefined;
    if (!source) return;
    try {
      const file = await readEditable(source.client, source.session, source.path, doc.readAs);
      if (file.kind === 'text') {
        if (file.revision !== doc.revision) this.replace(doc, file);
      } else for (const old of [...doc.sources.values()]) this.release(old.session, old.path);
    } catch (error) {
      doc.error = describeError(error);
      doc.status = 'conflict';
    }
    this.emit(doc);
  }

  /** 덮어쓰기 확인 뒤 새 revision으로만 저장해 확인 이후 변경도 충돌로 처리한다. */
  async overwrite(doc: EditorFile): Promise<boolean> {
    const sequence = doc.sequence;
    if (doc.inflight) await doc.inflight;
    const source = doc.sources.values().next().value as EditorSource | undefined;
    if (!source) return false;
    try {
      const file = await readEditable(source.client, source.session, source.path, doc.readAs);
      if (file.kind !== 'text') throw new Error(S.fileEditor.overwriteUnreadable);
      if (sequence !== doc.sequence) throw new Error(S.fileEditor.editedSinceConfirm);
      doc.revision = file.revision;
      doc.status = 'pending';
      doc.dirty = true;
      return await this.save(doc);
    } catch (error) {
      doc.error = describeError(error);
      doc.status = 'conflict';
      this.emit(doc);
      return false;
    }
  }

  /** 닫기 확인에서 폐기를 고르면 파일이 없어도 초안을 안전하게 버릴 수 있다. */
  async discard(session?: SessionId, path?: string): Promise<void> {
    const docs = this.documents(session, path);
    for (const doc of docs) {
      if (doc.inflight) await doc.inflight;
      clearTimeout(doc.timer);
      doc.state = EditorState.create({
        doc: editorText(doc.baseText),
        extensions: [history(), doc.language.of([]), doc.controls.of([]), doc.annotations.of([])],
      });
      doc.dirty = false;
      doc.status = 'saved';
      doc.error = null;
      doc.sequence += 1;
      doc.generation += 1;
      doc.imageEpoch += 1;
    }
    this.emit(...docs);
  }

  /** 닫힌 탭의 별칭을 해제하고 다른 화면에서도 쓰지 않는 깨끗한 문서를 제거한다. */
  release(session: SessionId, path?: string): void {
    const docs = this.documents(session, path);
    if (docs.length === 0) return;
    for (const doc of docs) {
      for (const [key, source] of doc.sources) {
        if (source.session === session && (path === undefined || source.path === path)) {
          doc.sources.delete(key);
          this.aliases.delete(key);
        }
      }
      if (!doc.sources.size && !doc.dirty && !doc.inflight) {
        clearTimeout(doc.timer);
        this.files.delete(doc.fileKey);
      }
    }
    this.emit(...docs);
  }

  /** 파일 구조 변경 중 갱신과 자동저장을 멈추고 오래된 읽기 응답을 무효화한다. */
  lockMutation(docs: readonly EditorFile[], locked: boolean): void {
    for (const doc of docs) {
      doc.mutationLocked = locked;
      doc.readSequence += 1;
      clearTimeout(doc.timer);
      if (!locked) this.schedule(doc);
    }
    this.emit(...docs);
  }

  /** 이동한 문서의 편집 상태를 유지하면서 모든 별칭과 디스크 식별자를 교체한다. */
  async remap(doc: EditorFile, sources: EditorSource[]): Promise<void> {
    const source = sources[0];
    if (!source) return;
    const file = await readEditable(source.client, source.session, source.path, doc.readAs);
    if (file.kind !== 'text') throw new Error(S.fileEditor.reloadUnreadable);
    for (const key of doc.sources.keys()) this.aliases.delete(key);
    this.files.delete(doc.fileKey);
    const replaced = this.files.get(file.fileKey);
    if (replaced && replaced !== doc) {
      for (const old of replaced.sources.values()) {
        if (!sources.some((s) => s.session === old.session && s.path === old.path))
          sources.push(old);
      }
    }
    doc.sources.clear();
    doc.fileKey = file.fileKey;
    doc.path = source.path;
    doc.revision = file.revision;
    doc.baseText = file.text;
    doc.dirty = false;
    doc.status = 'saved';
    for (const item of sources) {
      const key = sourceKey(item.session, item.path);
      doc.sources.set(key, item);
      this.aliases.set(key, doc);
    }
    this.files.set(doc.fileKey, doc);
    this.emit(doc, ...(replaced && replaced !== doc ? [replaced] : []));
  }

  /**
   * 세션 안 경로 이름만 바뀐 문서(그룹 별칭 바꾸기, M4)의 별칭을 새 경로로 옮긴다. 가리키는 실제 파일은 같으므로 다시 읽지
   * 않고 초안·저장 상태를 그대로 둔다. `move` 가 null 이거나 같은 경로를 돌려주면 그 별칭은 그대로다. 서로 맞바꾸는 이름도
   * 섞이지 않게 옛 별칭을 모두 지운 뒤 새 별칭을 건다
   */
  renameSources(session: SessionId, move: (path: string) => string | null): void {
    const moves: { doc: EditorFile; key: string; source: EditorSource; path: string }[] = [];
    for (const doc of this.documents(session)) {
      for (const [key, source] of doc.sources) {
        if (source.session !== session) continue;
        const path = move(source.path);
        if (path !== null && path !== source.path) moves.push({ doc, key, source, path });
      }
    }
    if (moves.length === 0) return;
    for (const { doc, key } of moves) {
      doc.sources.delete(key);
      this.aliases.delete(key);
    }
    for (const { doc, source, path } of moves) {
      const key = sourceKey(session, path);
      doc.sources.set(key, { ...source, path });
      this.aliases.set(key, doc);
      if (doc.path === source.path) doc.path = path;
    }
    this.emit(...moves.map((m) => m.doc));
  }

  /** 세션 안 경로에 사용자가 고른 인코딩 (R2). 고르지 않았으면 null — 코어가 정한다 */
  encodingChoice(session: SessionId, path: string): FsEncoding | null {
    return this.encodings.get(sourceKey(session, path)) ?? null;
  }

  /**
   * 그 경로를 `encoding` 으로 다시 열게 한다 (R2, null 이면 코어가 정하는 자동으로 되돌린다). 저장하지 않은 편집·저장
   * 중·한글 조합 중이면 바꾸지 않고 false — 다른 인코딩으로 다시 읽으면 초안을 잃는다. 바꾸면 그 경로의 별칭을 풀어 다음
   * `open` 이 새로 읽는다 (같은 파일을 연 다른 탭은 그 `open` 이 같은 문서를 새 원문으로 바꾼다)
   */
  chooseEncoding(session: SessionId, path: string, encoding: FsEncoding | null): boolean {
    const doc = this.get(session, path);
    if (doc && (doc.dirty || doc.inflight || doc.composing)) return false;
    const key = sourceKey(session, path);
    if (encoding === null) this.encodings.delete(key);
    else this.encodings.set(key, encoding);
    if (doc) this.release(session, path);
    else this.emit();
    return true;
  }

  /** 세션 종료 시 그 세션의 모든 별칭과 고른 인코딩을 해제한다. */
  releaseSession(session: SessionId): void {
    for (const key of [...this.encodings.keys()])
      if (JSON.parse(key)[0] === session) this.encodings.delete(key);
    this.release(session);
  }
}

export const fileEditors = new FileEditorStore();
