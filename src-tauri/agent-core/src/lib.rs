//! agent-core — the inner-circle crate of the Rust backend.
//!
//! Owns the domain vocabulary for agent turns ([`AgentEvent`]) and the
//! provider abstraction ([`Provider`]) with one adapter per AI vendor CLI.
//! Dependency Rule: this crate performs no I/O and knows nothing about
//! Tauri, processes, or windows — the outer shell (`mota-editor` crate)
//! depends on it, never the other way around.

pub mod acp;
pub mod badge;
pub mod billing;
pub mod commands;
pub mod event;
pub mod extension;
pub mod history;
pub mod mcp;
pub mod provider;
pub mod providers;
pub mod session_meta;
pub mod shell;
pub mod turn;
pub mod vcs;
pub mod worktree;

pub use event::{AgentEvent, PermissionOptionInfo};
pub use provider::{provider_for, Provider, TurnCommand};
pub use turn::{Mode, Permission, TurnRequest};
