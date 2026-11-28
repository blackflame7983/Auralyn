//! 中核から画面の層へ出す出来事。
//!
//! 出来事は名前と JSON の本文の組。本文は `serde_json::to_string` で1回だけ作り、
//! 画面の層はそれをそのまま渡す（GPUI はチャネルから受けて `payload` で読む）。
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fmt;
use std::sync::mpsc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    name: String,
    json: String,
}

impl Event {
    pub fn new<S: Serialize + ?Sized>(name: &str, payload: &S) -> Result<Self, EmitError> {
        Ok(Self {
            name: name.to_owned(),
            json: serde_json::to_string(payload).map_err(EmitError::Serialize)?,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn json(&self) -> &str {
        &self.json
    }

    pub fn into_parts(self) -> (String, String) {
        (self.name, self.json)
    }

    pub fn payload<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(&self.json)
    }
}

#[derive(Debug)]
pub enum EmitError {
    Serialize(serde_json::Error),
    /// 受け取る側が閉じている、または渡せなかった。
    Sink(Box<dyn std::error::Error + Send + Sync>),
}

impl fmt::Display for EmitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialize(error) => write!(f, "出来事の本文を作れません: {error}"),
            Self::Sink(error) => write!(f, "出来事を渡せません: {error}"),
        }
    }
}

impl std::error::Error for EmitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Serialize(error) => Some(error),
            Self::Sink(error) => Some(error.as_ref()),
        }
    }
}

/// 出来事の受け取り口。画面の層が1つ実装する。
pub trait EventSink: Send + Sync {
    fn send(&self, event: Event) -> Result<(), EmitError>;
}

/// 同じプロセスの中で出来事を受けるための口（GPUI などの画面の層、試験）。
#[derive(Clone)]
pub struct ChannelSink(mpsc::Sender<Event>);

pub fn channel() -> (ChannelSink, mpsc::Receiver<Event>) {
    let (sender, receiver) = mpsc::channel();
    (ChannelSink(sender), receiver)
}

impl EventSink for ChannelSink {
    fn send(&self, event: Event) -> Result<(), EmitError> {
        self.0
            .send(event)
            .map_err(|error| EmitError::Sink(error.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct Started {
        sample_rate: u32,
        level: f32,
    }

    #[test]
    fn body_is_the_same_text_as_direct_serialization() {
        let payload = Started {
            sample_rate: 48_000,
            level: 0.1,
        };
        let event = Event::new("audio-started", &payload).unwrap();
        assert_eq!(event.json(), serde_json::to_string(&payload).unwrap());
        assert_eq!(event.json(), r#"{"sample_rate":48000,"level":0.1}"#);
    }

    #[test]
    fn channel_delivers_in_order_and_reports_a_closed_receiver() {
        let (sink, receiver) = channel();
        sink.send(Event::new("a", &1).unwrap()).unwrap();
        sink.send(Event::new("b", &()).unwrap()).unwrap();
        let first = receiver.recv().unwrap();
        assert_eq!((first.name(), first.payload::<i32>().unwrap()), ("a", 1));
        assert_eq!(
            receiver.recv().unwrap().into_parts(),
            ("b".to_owned(), "null".to_owned())
        );
        drop(receiver);
        assert!(matches!(
            sink.send(Event::new("c", &()).unwrap()),
            Err(EmitError::Sink(_))
        ));
    }
}
