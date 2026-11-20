//! Erro único dos comandos, serializado como `{ code, message }`.
use serde::{Serialize, Serializer, ser::SerializeStruct};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Corrupt(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Permission(String),
    #[error("{0}")]
    ChangedOnDisk(String),
}

impl AppError {
    /// Código estável usado pela interface para traduzir a mensagem.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Unsupported(_) => "unsupported",
            AppError::Corrupt(_) => "corrupt",
            AppError::Io(_) => "io",
            AppError::Permission(_) => "permission",
            AppError::ChangedOnDisk(_) => "changed_on_disk",
        }
    }

    pub fn corrupt(e: impl std::fmt::Display) -> Self {
        AppError::Corrupt(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        match e.kind() {
            NotFound => AppError::NotFound(e.to_string()),
            PermissionDenied => AppError::Permission(e.to_string()),
            UnexpectedEof | InvalidData => AppError::Corrupt(e.to_string()),
            _ => AppError::Io(e.to_string()),
        }
    }
}

impl From<image::ImageError> for AppError {
    fn from(e: image::ImageError) -> Self {
        use image::ImageError::*;
        match e {
            IoError(io) => io.into(),
            Unsupported(u) => AppError::Unsupported(u.to_string()),
            Limits(l) => AppError::Unsupported(l.to_string()),
            other => AppError::Corrupt(other.to_string()),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
