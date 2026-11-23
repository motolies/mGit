//! 장시간 명령(clone·fetch·push·commit hook …)의 등록·취소와 출력 스트리밍 (RM-05, CHG-06)

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use mgit_git::parse::ProgressTracker;
use mgit_model::{CancelToken, OutputSink};

use crate::events::{CoreEvent, EventSink, SessionId};

/// 진행 중 명령 핸들
#[derive(Clone, Debug)]
pub struct OpHandle {
    pub id: u64,
    pub session: SessionId,
    pub cancel: CancelToken,
}

/// 진행 중 명령 등록부
#[derive(Debug, Default)]
pub struct OperationRegistry {
    next_id: AtomicU64,
    active: Mutex<HashMap<u64, OpHandle>>,
}

impl OperationRegistry {
    /// 새 핸들을 등록한다
    pub fn begin(&self, session: SessionId) -> OpHandle {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let handle = OpHandle {
            id,
            session,
            cancel: CancelToken::new(),
        };
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, handle.clone());
        handle
    }

    /// 등록을 지운다
    pub fn end(&self, id: u64) {
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }

    /// 취소 신호를 보낸다. 모르는 id 면 `false`
    pub fn cancel(&self, id: u64) -> bool {
        match self
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
        {
            Some(h) => {
                h.cancel.cancel();
                true
            }
            None => false,
        }
    }

    /// 세션의 모든 명령을 취소한다 (세션 닫을 때)
    pub fn cancel_session(&self, session: SessionId) {
        for h in self
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            if h.session == session {
                h.cancel.cancel();
            }
        }
    }
}

/// 출력을 줄 단위로 잘라 `OperationOutput` 이벤트로 보내는 싱크.
/// 청크 경계에서 UTF-8 문자가 잘리지 않도록 `\n`·`\r` 까지 모았다가 보낸다
pub struct LineEventSink {
    sink: Arc<dyn EventSink>,
    session: SessionId,
    op_id: u64,
    stdout_buf: Mutex<Vec<u8>>,
    stderr_buf: Mutex<Vec<u8>>,
    /// stderr 진행률 줄을 `OperationProgress` 로 바꿀지와 그 추적기
    progress: Option<Mutex<ProgressTracker>>,
}

impl LineEventSink {
    /// 싱크를 만든다. `progress` 면 stderr 의 `--progress` 줄을 진행률 이벤트로 바꾼다
    pub fn new(sink: Arc<dyn EventSink>, session: SessionId, op_id: u64, progress: bool) -> Self {
        LineEventSink {
            sink,
            session,
            op_id,
            stdout_buf: Mutex::new(Vec::new()),
            stderr_buf: Mutex::new(Vec::new()),
            progress: progress.then(|| Mutex::new(ProgressTracker::default())),
        }
    }

    /// 버퍼에 청크를 넣고 완성된 줄을 이벤트로 보낸다
    fn feed(&self, buf: &Mutex<Vec<u8>>, stderr: bool, bytes: &[u8]) {
        let mut b = buf.lock().unwrap_or_else(PoisonError::into_inner);
        b.extend_from_slice(bytes);
        let mut start = 0;
        for (i, &c) in b.iter().enumerate() {
            if c == b'\n' || c == b'\r' {
                let line = &b[start..i];
                if !line.is_empty() {
                    self.emit(stderr, line);
                }
                start = i + 1;
            }
        }
        b.drain(..start);
    }

    /// 남은 조각을 보낸다 (명령 종료 시)
    pub fn flush(&self) {
        for (buf, stderr) in [(&self.stdout_buf, false), (&self.stderr_buf, true)] {
            let mut b = buf.lock().unwrap_or_else(PoisonError::into_inner);
            if !b.is_empty() {
                let line = std::mem::take(&mut *b);
                self.emit(stderr, &line);
            }
        }
    }

    /// 한 줄을 이벤트로. 진행률 줄이면 `OperationProgress`
    fn emit(&self, stderr: bool, line: &[u8]) {
        if stderr && let Some(tracker) = &self.progress {
            let text = String::from_utf8_lossy(line);
            let parsed = tracker
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .feed(&text);
            if let Some((p, overall)) = parsed {
                self.sink.emit(CoreEvent::OperationProgress {
                    session: self.session,
                    op_id: self.op_id,
                    phase: p.phase,
                    percent: Some(overall),
                    message: mgit_model::redact_text(&text),
                });
                return;
            }
        }
        self.sink.emit(CoreEvent::OperationOutput {
            session: self.session,
            op_id: self.op_id,
            stderr,
            text: mgit_model::redact_text(&String::from_utf8_lossy(line)),
        });
    }
}

impl OutputSink for LineEventSink {
    fn on_stdout(&self, bytes: &[u8]) {
        self.feed(&self.stdout_buf, false, bytes);
    }

    fn on_stderr(&self, bytes: &[u8]) {
        self.feed(&self.stderr_buf, true, bytes);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;

    #[test]
    fn line_sink_splits_on_newline_and_cr_and_flushes_rest() {
        let got: Arc<StdMutex<Vec<(bool, String)>>> = Arc::new(StdMutex::new(Vec::new()));
        let g2 = Arc::clone(&got);
        let sink: Arc<dyn EventSink> = Arc::new(move |e: CoreEvent| {
            if let CoreEvent::OperationOutput { stderr, text, .. } = e {
                g2.lock().unwrap().push((stderr, text));
            }
        });
        let ls = LineEventSink::new(sink, SessionId(1), 7, false);
        ls.on_stderr("Receiving: 10%\rReceiving: 50%\r한".as_bytes());
        ls.on_stderr("글\ntail".as_bytes());
        ls.on_stdout(b"out\n");
        ls.flush();
        let v = got.lock().unwrap();
        assert_eq!(
            *v,
            vec![
                (true, "Receiving: 10%".to_string()),
                (true, "Receiving: 50%".to_string()),
                (true, "한글".to_string()),
                (false, "out".to_string()),
                (true, "tail".to_string()),
            ]
        );
    }

    #[test]
    fn registry_cancels_by_id_and_session() {
        let reg = OperationRegistry::default();
        let a = reg.begin(SessionId(1));
        let b = reg.begin(SessionId(2));
        assert!(reg.cancel(a.id));
        assert!(a.cancel.is_cancelled());
        assert!(!b.cancel.is_cancelled());
        reg.cancel_session(SessionId(2));
        assert!(b.cancel.is_cancelled());
        reg.end(a.id);
        assert!(!reg.cancel(a.id));
    }
}
