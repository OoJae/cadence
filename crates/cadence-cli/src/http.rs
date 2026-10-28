//! The payer's HTTP to the merchant's runner. It goes over Tor unless the runner is
//! on this machine or `--direct` is given, so neither the runner nor the network
//! learns where the payer is.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde_json::Value;
use zcash_client_backend::tor::{
    self,
    http::{HttpError, Retry},
};

#[derive(Clone)]
pub enum Http {
    Direct(ureq::Agent),
    /// Requests run on `rt` from blocking threads, on circuits isolated from the
    /// payer's lightwalletd traffic.
    Tor { client: tor::Client, rt: tokio::runtime::Handle },
}

/// Whether `url` points at this machine, which Tor cannot reach.
pub fn is_loopback(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => rest.split([':', '/']).next().unwrap_or(""),
    };
    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

impl Http {
    pub fn direct() -> Self {
        Http::Direct(
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(120)))
                .build()
                .into(),
        )
    }

    pub fn tor(client: &tor::Client) -> Self {
        Http::Tor { client: client.isolated_client(), rt: tokio::runtime::Handle::current() }
    }

    pub fn get_json(&self, url: &str) -> Result<Value> {
        match self {
            Http::Direct(agent) => {
                let mut response = agent.get(url).call()?;
                decode(response.status().as_u16(), &response.body_mut().read_to_vec()?)
            }
            Http::Tor { client, rt } => {
                let response = rt
                    .block_on(client.http_get(
                        url.parse()?,
                        |b| b.header("Accept", "application/json"),
                        |body| async { Ok(body.collect().await.map_err(HttpError::Hyper)?.to_bytes()) },
                        2,
                        |res| res.is_err().then_some(Retry::Isolated),
                    ))
                    .map_err(|e| anyhow!("GET {url} over Tor: {e}"))?;
                decode(response.status().as_u16(), response.body())
            }
        }
    }

    /// [`Self::get_json`] for async callers.
    pub async fn get(&self, url: &str) -> Result<Value> {
        let (http, url) = (self.clone(), url.to_string());
        tokio::task::spawn_blocking(move || http.get_json(&url)).await?
    }

    pub fn post_json(&self, url: &str, body: &Value) -> Result<Value> {
        self.post_bytes(url, serde_json::to_vec(body)?, &[])
    }

    /// POSTs exactly `bytes` as JSON, with `headers` besides, as a signed request needs.
    pub fn post_bytes(&self, url: &str, bytes: Vec<u8>, headers: &[(&str, String)]) -> Result<Value> {
        match self {
            Http::Direct(agent) => {
                let mut request = agent.post(url).header("Content-Type", "application/json");
                for (name, value) in headers {
                    request = request.header(*name, value);
                }
                let mut response = request.send(&bytes[..])?;
                decode(response.status().as_u16(), &response.body_mut().read_to_vec()?)
            }
            Http::Tor { client, rt } => {
                // No retries: a POST may have reached the runner before the circuit failed.
                let response = rt
                    .block_on(client.http_post(
                        url.parse()?,
                        |b| {
                            let b = b.header("Content-Type", "application/json").header("Accept", "application/json");
                            headers.iter().fold(b, |b, (name, value)| b.header(*name, value))
                        },
                        Full::new(Bytes::from(bytes)),
                        |body| async { Ok(body.collect().await.map_err(HttpError::Hyper)?.to_bytes()) },
                        0,
                        |_| None,
                    ))
                    .map_err(|e| anyhow!("POST {url} over Tor: {e}"))?;
                decode(response.status().as_u16(), response.body())
            }
        }
    }
}

fn decode(status: u16, body: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(body)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(body).into_owned()));
    if !(200..300).contains(&status) {
        bail!("runner answered {status}: {value}");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::is_loopback;

    #[test]
    fn loopback() {
        assert!(is_loopback("http://127.0.0.1:8737"));
        assert!(is_loopback("http://localhost/api"));
        assert!(is_loopback("http://[::1]:8737"));
        assert!(!is_loopback("https://pay.example.com"));
        assert!(!is_loopback("https://127.0.0.1.sslip.io"));
    }
}
