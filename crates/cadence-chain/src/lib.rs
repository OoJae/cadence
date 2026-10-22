//! Light-client chain access shared by the Cadence payer and runner.
//!
//! Everything a Cadence process learns about the chain comes through lightwalletd.
//! Production builds reach it over Tor ([`Transport::Tor`]); direct TLS exists only
//! for local development against a node the operator runs themselves.

pub mod cache;
pub mod lwd;
pub mod wallet;

pub use cache::MemBlockCache;
pub use lwd::{connect, Client, Transport};
