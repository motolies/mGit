//! 통합 터미널 PTY (UX-08): 로그인 셸을 pty 로 띄우고 출력은 채널로 흘린다

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};

use mgit_l10n::{pick, tr};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::IpcError;

/// 터미널별 입력 대기열 길이. 넘치면 입력을 거부해 호출자가 막히지 않게 한다
const WRITE_QUEUE: usize = 256;

/// 프런트로 보내는 터미널 이벤트
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    /// 출력 (UTF-8 경계에 맞춰 잘라 보낸다)
    Data { id: u32, data: String },
    /// 셸이 끝났다
    Exit { id: u32, code: Option<u32> },
}

/// 열린 터미널 하나
struct Handle {
    master: Box<dyn MasterPty + Send>,
    /// 쓰기 스레드로 보내는 입력 대기열
    input: SyncSender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// 터미널 레지스트리 (앱 상태)
#[derive(Default)]
pub struct PtyState {
    handles: Mutex<HashMap<u32, Handle>>,
    next: AtomicU32,
}

/// 모인 바이트에서 보낼 수 있는 문자열을 꺼낸다. 잘못된 바이트는 U+FFFD 로 바꾸고 그 뒤의 출력은
/// 살린다. 끝에서 잘린 다중 바이트 문자는 다음 청크를 기다린다
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut text = String::new();
    let mut rest: &[u8] = pending;
    loop {
        match std::str::from_utf8(rest) {
            Ok(tail) => {
                text.push_str(tail);
                rest = &[];
                break;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                text.push_str(&String::from_utf8_lossy(good));
                let Some(len) = e.error_len() else {
                    rest = bad;
                    break;
                };
                text.push(char::REPLACEMENT_CHARACTER);
                rest = &bad[len..];
            }
        }
    }
    let done = pending.len() - rest.len();
    pending.drain(..done);
    text
}

/// 터미널 입력을 전담하는 스레드. pty 쓰기는 상대가 읽지 않으면 막히므로 호출자와 분리한다.
/// 보내는 쪽이 사라지면(닫기) 끝난다
fn spawn_writer(mut writer: Box<dyn Write + Send>, input: Receiver<Vec<u8>>) {
    std::thread::spawn(move || {
        while let Ok(data) = input.recv() {
            if writer
                .write_all(&data)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
}

/// 내부 오류 → IPC 오류
fn internal(e: impl std::fmt::Display) -> IpcError {
    IpcError::Internal {
        message: e.to_string(),
    }
}

/// 없는 터미널 id 를 받았다 (지금 언어)
fn no_terminal(id: u32) -> IpcError {
    internal(tr!("터미널이 없습니다: {id}", "Terminal not found: {id}"))
}

impl PtyState {
    /// 로그인 셸을 띄운다. 출력은 채널로 보낸다
    pub fn open(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        extra_path: Option<&str>,
        channel: Channel<PtyEvent>,
    ) -> Result<u32, IpcError> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("MGIT_TERMINAL", "1");
        if let Some(p) = extra_path {
            cmd.env("PATH", p);
        }
        self.open_command(cmd, cols, rows, move |event| channel.send(event).is_ok())
    }

    /// 명령을 pty 에서 띄운다. 출력은 읽기 스레드가 `on_event` 로 보낸다 (false 면 그만 보낸다)
    fn open_command(
        &self,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        on_event: impl Fn(PtyEvent) -> bool + Send + 'static,
    ) -> Result<u32, IpcError> {
        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(internal)?;
        let mut child = pair.slave.spawn_command(cmd).map_err(internal)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(internal)?;
        let writer = pair.master.take_writer().map_err(internal)?;
        let (input, queue) = sync_channel(WRITE_QUEUE);
        spawn_writer(writer, queue);
        let killer = child.clone_killer();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                id,
                Handle {
                    master: pair.master,
                    input,
                    killer,
                },
            );
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let text = take_utf8(&mut pending);
                        if !text.is_empty() && !on_event(PtyEvent::Data { id, data: text }) {
                            break;
                        }
                    }
                }
            }
            let code = child.wait().ok().map(|s| s.exit_code());
            on_event(PtyEvent::Exit { id, code });
        });
        Ok(id)
    }

    /// 입력을 대기열에 넣는다. 전역 락을 쥐고 막히지 않도록 실제 쓰기는 터미널별 스레드가 한다.
    /// 프로그램이 입력을 읽지 않아 대기열이 차면 거부한다
    pub fn write(&self, id: u32, data: &str) -> Result<(), IpcError> {
        let map = self
            .handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let h = map.get(&id).ok_or_else(|| no_terminal(id))?;
        h.input
            .try_send(data.as_bytes().to_vec())
            .map_err(|e| match e {
                TrySendError::Full(_) => internal(pick(
                    "터미널이 입력을 읽지 않아 대기열이 찼습니다",
                    "The terminal is not reading input, so the input queue is full",
                )),
                TrySendError::Disconnected(_) => {
                    internal(tr!("터미널이 닫혔습니다: {id}", "Terminal closed: {id}"))
                }
            })
    }

    /// 크기 변경
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), IpcError> {
        let map = self
            .handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let h = map.get(&id).ok_or_else(|| no_terminal(id))?;
        h.master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(internal)
    }

    /// 닫기 (셸 프로세스도 끝낸다)
    pub fn close(&self, id: u32) {
        let removed = self
            .handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        if let Some(mut h) = removed {
            let _ = h.killer.kill();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
// unix 전용 테스트만 쓰는 import·도우미는 다른 OS 빌드에서 쓰이지 않는다
#[cfg_attr(not(unix), allow(unused_imports, unused_variables, dead_code))]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// 잘못된 바이트 뒤의 정상 출력을 버리지 않는다
    #[test]
    fn invalid_byte_keeps_following_output() {
        let mut pending = b"abc\xffdef".to_vec();
        assert_eq!(take_utf8(&mut pending), "abc\u{FFFD}def");
        assert!(pending.is_empty());
    }

    /// 잘못된 바이트 뒤에서 청크가 다중 바이트 문자 중간에 끊겨도 다음 청크와 이어 붙인다
    #[test]
    fn split_char_after_invalid_byte_survives_chunk_boundary() {
        let han = "한글자".as_bytes();
        let mut pending = vec![0xff];
        pending.extend_from_slice(&han[..2]);
        assert_eq!(take_utf8(&mut pending), "\u{FFFD}");
        assert_eq!(pending.len(), 2, "잘린 문자는 남긴다");
        pending.extend_from_slice(&han[2..]);
        assert_eq!(take_utf8(&mut pending), "한글자");
        assert!(pending.is_empty());
    }

    /// 입력을 읽지 않는 터미널이 있어도 쓰기·닫기가 막히지 않고, 대기열이 차면 거부한다
    #[cfg(unix)]
    #[test]
    fn stuck_terminal_rejects_input_instead_of_blocking() {
        let state = Arc::new(PtyState::default());
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "stty raw -echo; echo ready; sleep 30"]);
        let (ready_tx, ready_rx) = mpsc::channel();
        let id = state
            .open_command(cmd, 80, 24, move |event| {
                if matches!(&event, PtyEvent::Data { data, .. } if data.contains("ready")) {
                    let _ = ready_tx.send(());
                }
                true
            })
            .unwrap();
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();

        let (done_tx, done_rx) = mpsc::channel();
        let worker = Arc::clone(&state);
        std::thread::spawn(move || {
            let chunk = "a".repeat(4096);
            let rejected = (0..WRITE_QUEUE * 2).any(|_| worker.write(id, &chunk).is_err());
            worker.close(id);
            let _ = done_tx.send(rejected);
        });
        let rejected = done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("쓰기나 닫기가 막혔다");
        assert!(rejected, "대기열이 차면 입력을 거부해야 한다");
    }
}
