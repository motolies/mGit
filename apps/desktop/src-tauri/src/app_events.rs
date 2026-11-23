//! 세션과 무관한 앱 이벤트. 전역 `emit` 대신 프런트가 등록한 채널 하나로 보내고,
//! 구독 전에 생긴 이벤트는 버퍼에 쌓았다가 구독 시 전달한다 (리스너 등록 레이스 회피)

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::ipc::Channel;

/// 앱 이벤트 (TS 쪽 `type` 태그와 1:1)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AppEvent {
    /// 두 번째 실행 인자·드롭 등으로 경로 열기가 요청됐다
    OpenRequested { paths: Vec<String> },
    /// git·ssh 가 자격 증명을 묻는다 (AU-01). 프런트는 `credential_reply` 로 답한다
    CredentialRequested {
        req_id: u32,
        /// `username` | `password` | `passphrase` | `other`
        kind: String,
        target: String,
        prompt: String,
    },
}

#[derive(Default)]
struct Inner {
    channel: Option<Channel<AppEvent>>,
    buffer: Vec<AppEvent>,
}

/// 앱 이벤트 허브
#[derive(Default)]
pub struct AppEvents {
    inner: Mutex<Inner>,
}

impl AppEvents {
    /// 채널을 등록하고 밀린 이벤트를 흘려보낸다
    pub fn subscribe(&self, channel: Channel<AppEvent>) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        for ev in inner.buffer.drain(..) {
            let _ = channel.send(ev);
        }
        inner.channel = Some(channel);
    }

    /// 이벤트를 보낸다. 구독자가 없으면 버퍼에 둔다
    pub fn emit(&self, event: AppEvent) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        match &inner.channel {
            Some(ch) => {
                let _ = ch.send(event);
            }
            None => inner.buffer.push(event),
        }
    }
}
