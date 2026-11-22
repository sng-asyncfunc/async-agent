//! Sinks shipped with the crate.

pub mod analytics;
pub mod file;
pub mod mock;
pub mod noop;

pub use analytics::{
    configured_endpoint, parse_endpoint, AnalyticsSink, TELEMETRY_ENDPOINT_ENV,
};
pub use file::FileSink;
pub use mock::{MockSink, RecordedBatch};
pub use noop::NoopSink;
