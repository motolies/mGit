//! `--progress` stderr 파서 (RM-05). git 은 `"<제목>:  45% (123/273)…\r"` 형식으로
//! 진행률을 찍고, 끝나면 `", done.\n"` 을 붙인다. 서버 쪽 출력은 `remote: ` 접두가 붙는다

/// 진행률 한 줄
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgressLine {
    /// 단계 제목 (`Receiving objects` 등)
    pub phase: String,
    /// 단계 안 퍼센트
    pub percent: u8,
    pub current: u64,
    pub total: u64,
    /// `remote: ` 접두가 있었는지
    pub remote: bool,
    pub done: bool,
}

/// 줄 하나를 파싱한다. 진행률 줄이 아니면 `None`
pub fn parse_progress_line(line: &str) -> Option<ProgressLine> {
    let line = line.trim();
    let (remote, rest) = match line.strip_prefix("remote: ") {
        Some(r) => (true, r),
        None => (false, line),
    };
    let (phase, after) = rest.split_once(':')?;
    let after = after.trim_start();
    let pct_end = after.find('%')?;
    let percent: u8 = after[..pct_end].trim().parse().ok()?;
    let paren = after[pct_end..].find('(')?;
    let close = after[pct_end + paren..].find(')')?;
    let inner = &after[pct_end + paren + 1..pct_end + paren + close];
    let (cur, tot) = inner.split_once('/')?;
    Some(ProgressLine {
        phase: phase.trim().to_string(),
        percent: percent.min(100),
        current: cur.trim().parse().ok()?,
        total: tot.trim().parse().ok()?,
        remote,
        done: after.contains("done"),
    })
}

/// 단계별 가중치로 전체 진행률을 추정한다. 단계 순서는 fetch(Receiving) 와 push(Writing) 둘 다 포함
#[derive(Debug, Default)]
pub struct ProgressTracker {
    last_phase: Option<String>,
    last_overall: u8,
}

/// (단계 제목, 그 단계가 시작하는 전체 퍼센트, 그 단계의 비중)
const PHASES: &[(&str, u8, u8)] = &[
    ("Enumerating objects", 0, 5),
    ("Counting objects", 5, 5),
    ("Compressing objects", 10, 15),
    ("Writing objects", 25, 60),
    ("Receiving objects", 25, 55),
    ("Resolving deltas", 80, 15),
    ("Updating files", 95, 5),
];

impl ProgressTracker {
    /// 줄을 반영하고 전체 퍼센트(0..=100)를 돌려준다. 진행률 줄이 아니면 `None`
    pub fn feed(&mut self, line: &str) -> Option<(ProgressLine, u8)> {
        let p = parse_progress_line(line)?;
        let (base, weight) = PHASES
            .iter()
            .find(|(name, _, _)| p.phase.starts_with(name))
            .map(|(_, b, w)| (*b, *w))
            .unwrap_or((self.last_overall, 0));
        let overall = (base as u32 + (p.percent as u32 * weight as u32) / 100).min(100) as u8;
        // 단계가 바뀌어도 전체 퍼센트는 뒤로 가지 않는다
        let overall = overall.max(self.last_overall);
        self.last_overall = overall;
        self.last_phase = Some(p.phase.clone());
        Some((p, overall))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_running_and_done_lines() {
        let p = parse_progress_line("Receiving objects:  45% (123/273), 1.23 MiB | 456.00 KiB/s")
            .unwrap();
        assert_eq!(p.phase, "Receiving objects");
        assert_eq!((p.percent, p.current, p.total), (45, 123, 273));
        assert!(!p.done && !p.remote);
        let d = parse_progress_line("remote: Compressing objects: 100% (10/10), done.").unwrap();
        assert!(d.done && d.remote);
        assert_eq!(parse_progress_line("error: failed to push"), None);
        assert_eq!(parse_progress_line("From /tmp/remote"), None);
    }

    #[test]
    fn tracker_is_monotonic_and_weighted() {
        let mut t = ProgressTracker::default();
        let (_, a) = t.feed("Counting objects: 50% (1/2)").unwrap();
        assert_eq!(a, 7);
        let (_, b) = t.feed("Receiving objects: 100% (9/9), done.").unwrap();
        assert_eq!(b, 80);
        let (_, c) = t.feed("Resolving deltas: 0% (0/3)").unwrap();
        assert_eq!(c, 80);
        let (_, d) = t.feed("Resolving deltas: 100% (3/3), done.").unwrap();
        assert_eq!(d, 95);
    }
}
