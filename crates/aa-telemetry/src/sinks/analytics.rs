//! Opt-in HTTP analytics sink.
//!
//! Disabled by default: remote delivery only occurs when an explicit endpoint is
//! configured via [`TELEMETRY_ENDPOINT_ENV`] (`ASYNC_AGENT_TELEMETRY_ENDPOINT`)
//! or passed directly to [`AnalyticsSink::new`] in tests.
//!
//! Wire format: `POST <endpoint>` with `{"installation_id", "events": [{"id",
//! "name", "timestamp", "properties"}]}`, `content-type: application/json`,
//! `user-agent: async-agent/<version>`, no credentials.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{json, Value};

use crate::event::TelemetryEvent;
use crate::sink::{SinkOutcome, TelemetrySink};

/// Environment variable that opts into a remote telemetry endpoint.
/// Unset or blank means telemetry stays local/no-op (no remote phone-home).
pub const TELEMETRY_ENDPOINT_ENV: &str = "ASYNC_AGENT_TELEMETRY_ENDPOINT";

/// Parse a raw endpoint override value: empty/whitespace strings mean disabled.
#[must_use]
pub fn parse_endpoint(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Resolve the configured remote telemetry endpoint from [`TELEMETRY_ENDPOINT_ENV`].
/// Returns `None` by default so Async Agent never phones home unless explicitly configured.
#[must_use]
pub fn configured_endpoint() -> Option<String> {
    parse_endpoint(std::env::var(TELEMETRY_ENDPOINT_ENV).ok().as_deref())
}

/// Requests time out after 1.5s so telemetry never holds the agent.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

/// Batches to a configured analytics endpoint. Best-effort: a transport error,
/// timeout, non-2xx status, or a 2xx that accepted nothing (`{"accepted": 0}`)
/// reports [`SinkOutcome::Dropped`], and the client's bounded retry re-sends
/// the same event ids.
#[derive(Clone)]
pub struct AnalyticsSink {
    http: reqwest::Client,
    endpoint: String,
}

impl AnalyticsSink {
    /// Sink posting to `endpoint` with the 1.5s request timeout.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self::with_timeout(endpoint, DEFAULT_REQUEST_TIMEOUT)
    }

    /// Sink with an explicit request timeout (tests).
    ///
    /// # Panics
    ///
    /// Panics if the reqwest HTTP client cannot be built.
    #[must_use]
    pub fn with_timeout(endpoint: impl Into<String>, timeout: Duration) -> Self {
        Self::with_timeout_and_builder(endpoint, timeout, reqwest::Client::builder())
    }

    /// Sink using the caller's HTTP trust configuration and the 1.5s request
    /// timeout. Product composition supplies its extra CA roots.
    ///
    /// # Panics
    ///
    /// Panics if the supplied HTTP client builder cannot be built.
    #[must_use]
    pub fn with_http_builder(
        endpoint: impl Into<String>,
        http_builder: reqwest::ClientBuilder,
    ) -> Self {
        Self::with_timeout_and_builder(endpoint, DEFAULT_REQUEST_TIMEOUT, http_builder)
    }

    fn with_timeout_and_builder(
        endpoint: impl Into<String>,
        timeout: Duration,
        http_builder: reqwest::ClientBuilder,
    ) -> Self {
        let http = http_builder
            .timeout(timeout)
            .build()
            .expect("reqwest client with rustls");
        Self {
            http,
            endpoint: endpoint.into(),
        }
    }

    /// The request body as it goes on the wire.
    #[must_use]
    pub fn batch_body(install_id: &str, events: &[TelemetryEvent]) -> Value {
        json!({
            "installation_id": install_id,
            "events": events.iter().map(TelemetryEvent::to_value).collect::<Vec<_>>(),
        })
    }
}

impl TelemetrySink for AnalyticsSink {
    fn send_batch<'a>(
        &'a self,
        install_id: &'a str,
        events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + 'a>> {
        Box::pin(async move {
            if events.is_empty() {
                return SinkOutcome::Sent;
            }
            let response = self
                .http
                .post(&self.endpoint)
                .header("content-type", "application/json")
                .header("user-agent", format!("async-agent/{}", crate::version()))
                .json(&Self::batch_body(install_id, &events))
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let accepted = response
                        .json::<Value>()
                        .await
                        .ok()
                        .and_then(|body| body.get("accepted").and_then(Value::as_u64));
                    if accepted == Some(0) {
                        tracing::debug!(
                            count = events.len(),
                            "telemetry batch accepted nothing, dropping"
                        );
                        SinkOutcome::Dropped
                    } else {
                        SinkOutcome::Sent
                    }
                }
                Ok(response) => {
                    tracing::debug!(
                        status = %response.status(),
                        count = events.len(),
                        "telemetry batch rejected, dropping"
                    );
                    SinkOutcome::Dropped
                }
                Err(err) => {
                    tracing::debug!(error = %err, count = events.len(), "telemetry batch send failed, dropping");
                    SinkOutcome::Dropped
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_endpoint_defaults_to_none_and_trims_explicit_values() {
        assert_eq!(parse_endpoint(None), None);
        assert_eq!(parse_endpoint(Some("")), None);
        assert_eq!(parse_endpoint(Some("   \t\n ")), None);
        assert_eq!(
            parse_endpoint(Some(" https://telemetry.example.com/v1/events ")),
            Some("https://telemetry.example.com/v1/events".to_string())
        );
    }
}
