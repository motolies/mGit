use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::ParseError;

/// SHA-1 객체 ID. 직렬화는 40자 소문자 hex 문자열로 한다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Oid([u8; 20]);

impl Oid {
    /// 모두 0인 ID. 존재하지 않는 객체를 뜻한다
    pub const ZERO: Oid = Oid([0; 20]);

    /// 40자 hex 바이트열을 파싱한다. 길이가 다르거나 hex가 아니면 오류
    pub fn from_hex(s: &[u8]) -> Result<Self, ParseError> {
        if s.len() != 40 {
            return Err(ParseError::BadOid(String::from_utf8_lossy(s).into_owned()));
        }
        let mut out = [0u8; 20];
        // 길이를 40으로 확인했으므로 2바이트 묶음 20개가 남김없이 나온다
        let (pairs, _) = s.as_chunks::<2>();
        for (i, &[hi, lo]) in pairs.iter().enumerate() {
            match (hex_nibble(hi), hex_nibble(lo)) {
                (Some(h), Some(l)) => out[i] = (h << 4) | l,
                _ => return Err(ParseError::BadOid(String::from_utf8_lossy(s).into_owned())),
            }
        }
        Ok(Oid(out))
    }

    /// 원시 20바이트로 만든다
    pub const fn from_bytes(bytes: [u8; 20]) -> Self {
        Oid(bytes)
    }

    /// 40자 소문자 hex 문자열로 바꾼다
    pub fn to_hex(&self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::with_capacity(40);
        for b in self.0 {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0x0f) as usize] as char);
        }
        s
    }

    /// 원시 바이트를 돌려준다
    pub fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }
}

/// hex 문자 하나를 0..16 값으로 바꾼다
fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

impl fmt::Display for Oid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for Oid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Oid({})", self.to_hex())
    }
}

impl Serialize for Oid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Oid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Oid::from_hex(s.as_bytes()).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const HEX: &str = "ba53f33a1b2c3d4e5f60718293a4b5c6d7e8f901";

    #[test]
    fn hex_round_trip() {
        let oid = Oid::from_hex(HEX.as_bytes()).unwrap();
        assert_eq!(oid.to_hex(), HEX);
        assert_eq!(oid.to_string(), HEX);
    }

    #[test]
    fn upper_case_is_accepted_and_normalized() {
        let oid = Oid::from_hex(HEX.to_uppercase().as_bytes()).unwrap();
        assert_eq!(oid.to_hex(), HEX);
    }

    #[test]
    fn rejects_bad_length_and_non_hex() {
        assert!(Oid::from_hex(b"abc").is_err());
        assert!(Oid::from_hex(b"zz53f33a1b2c3d4e5f60718293a4b5c6d7e8f901").is_err());
    }

    #[test]
    fn serde_uses_hex_string() {
        let oid = Oid::from_hex(HEX.as_bytes()).unwrap();
        let json = serde_json::to_string(&oid).unwrap();
        assert_eq!(json, format!("\"{HEX}\""));
        let back: Oid = serde_json::from_str(&json).unwrap();
        assert_eq!(back, oid);
    }
}
