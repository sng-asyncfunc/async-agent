//! Private-frame codec re-export. The codec is the shared worker-socket wire
//! contract (served by this crate's workers, spoken by direct-attach clients
//! in aa-tui/aa-cli), so it lives in [`aa_types::daemon::framing`].

pub use aa_types::daemon::framing::*;
