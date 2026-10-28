//! Per-client rate limits. Each client address has a token bucket per route class,
//! refilled continuously and held in memory only, so a restart forgets them. A
//! request carrying the merchant token is never limited.
//!
//! The client is the socket's peer, or, behind a proxy that sets it
//! (`CADENCE_TRUST_FORWARDED=1`), the first `X-Forwarded-For` hop. An IPv6 client
//! counts by its /64, which one subscriber usually holds whole.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{
    api::{is_merchant, ApiError},
    service::App,
};

/// The client a request came from, as the limits count it. The middleware puts it in
/// every request's extensions, for handlers with limits of their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ClientIp(pub IpAddr);

/// Routes that share a bucket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Class {
    /// `POST /api/pockets`: each one adds an account to the wallet.
    Pocket,
    /// Every other write, the sandbox's endpoints among them.
    Write,
    /// `GET /api/decode/{txid}`: up to thirteen lightwalletd lookups.
    Decode,
    /// Every other read, which pages poll.
    Read,
}

/// A bucket of `burst` tokens, one more every `every`.
pub struct Rate {
    pub burst: u32,
    pub every: Duration,
}

impl Class {
    pub fn of(method: &Method, path: &str) -> Class {
        if path == "/api/pockets" && method == Method::POST {
            Class::Pocket
        } else if path.starts_with("/api/sandbox/") {
            Class::Write
        } else if path.starts_with("/api/decode/") {
            Class::Decode
        } else if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
            Class::Read
        } else {
            Class::Write
        }
    }

    /// One payer's run through the sandbox (a pocket, an offer, a funding, the upload,
    /// every cheat and a cancel) fits in a burst; a status page decoding a year of
    /// installments does too.
    pub fn rate(self) -> Rate {
        let (burst, every_ms) = match self {
            Class::Pocket => (6, 60_000),
            Class::Write => (20, 6_000),
            Class::Decode => (20, 3_000),
            Class::Read => (300, 100),
        };
        Rate { burst, every: Duration::from_millis(every_ms) }
    }
}

/// Buckets idle long enough to be full again are dropped this often.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Past this many buckets a new client goes uncounted until a sweep makes room, so
/// a flood of addresses costs neither memory nor a sweep per request.
pub const MAX_BUCKETS: usize = 100_000;

/// Each bucket as the time at which it would be full again (GCRA): a request at `now`
/// moves it `every` later, and is refused if that is more than `burst * every` ahead.
pub struct Buckets {
    full_at: HashMap<(IpAddr, Class), Instant>,
    swept: Instant,
}

impl Buckets {
    pub fn new(now: Instant) -> Self {
        Buckets { full_at: HashMap::new(), swept: now }
    }

    /// Takes a token, or says how long until one is free.
    pub fn take(&mut self, client: IpAddr, class: Class, now: Instant) -> Result<(), Duration> {
        let since = now.saturating_duration_since(self.swept);
        if since >= SWEEP_EVERY || (self.full_at.len() >= MAX_BUCKETS && since >= Duration::from_secs(1)) {
            self.full_at.retain(|_, full_at| *full_at > now);
            self.swept = now;
        }
        let key = (client, class);
        let from = match self.full_at.get(&key) {
            Some(full_at) => (*full_at).max(now),
            None if self.full_at.len() >= MAX_BUCKETS => return Ok(()),
            None => now,
        };
        let rate = class.rate();
        let ahead = from + rate.every - now;
        let window = rate.every * rate.burst;
        if ahead > window {
            return Err(ahead - window);
        }
        self.full_at.insert(key, from + rate.every);
        Ok(())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.full_at.len()
    }
}

pub struct Limits {
    app: Arc<App>,
    buckets: Mutex<Buckets>,
}

impl Limits {
    pub fn new(app: Arc<App>) -> Self {
        Limits { app, buckets: Mutex::new(Buckets::new(Instant::now())) }
    }
}

/// The middleware: names the client, and refuses it past its bucket.
pub async fn check(State(limits): State<Arc<Limits>>, mut req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    let client = client_ip(req.headers(), peer, limits.app.cfg.trust_forwarded);
    req.extensions_mut().insert(ClientIp(client));
    if !is_merchant(&limits.app, req.headers()) {
        let class = Class::of(req.method(), req.uri().path());
        let taken = limits.buckets.lock().unwrap().take(client, class, Instant::now());
        if let Err(wait) = taken {
            let secs = whole_secs(wait);
            return too_many(secs, format!("too many requests; try again in {secs} s"));
        }
    }
    next.run(req).await
}

/// 429 with `Retry-After`, and the error JSON of every other refusal.
pub fn too_many(retry_after_secs: u64, message: String) -> Response {
    let mut res = ApiError(StatusCode::TOO_MANY_REQUESTS, message).into_response();
    res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(retry_after_secs));
    res
}

/// A wait in whole seconds, rounded up, and at least one.
fn whole_secs(wait: Duration) -> u64 {
    wait.as_millis().div_ceil(1000).max(1) as u64
}

pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_forwarded: bool) -> IpAddr {
    let forwarded = if trust_forwarded { first_forwarded(headers) } else { None };
    let ip = forwarded
        .or(peer.map(|p| p.ip()))
        .unwrap_or(IpAddr::V6(Ipv6Addr::UNSPECIFIED));
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

fn first_forwarded(headers: &HeaderMap) -> Option<IpAddr> {
    let first = headers.get("x-forwarded-for")?.to_str().ok()?.split(',').next()?.trim();
    first
        .parse::<IpAddr>()
        .ok()
        .or_else(|| first.parse::<SocketAddr>().ok().map(|s| s.ip()))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header, Request},
    };
    use serde_json::json;

    use super::*;
    use crate::api::{
        router,
        tests::{send, test_app, TOKEN},
    };

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn routes_fall_into_classes() {
        let class = |m: Method, p: &str| Class::of(&m, p);
        assert_eq!(class(Method::POST, "/api/pockets"), Class::Pocket);
        assert_eq!(class(Method::GET, "/api/pockets/pkt_1"), Class::Read);
        for p in ["/api/broadcast", "/api/subscriptions", "/api/offers", "/api/subscriptions/sub_1/stop"] {
            assert_eq!(class(Method::POST, p), Class::Write, "{p}");
        }
        for p in ["/api/sandbox/offer", "/api/sandbox/fund", "/api/sandbox/cheat"] {
            assert_eq!(class(Method::POST, p), Class::Write, "{p}");
            assert_eq!(class(Method::GET, p), Class::Write, "{p}");
        }
        assert_eq!(class(Method::GET, "/api/decode/ab"), Class::Decode);
        for p in ["/api/status", "/api/subscriptions", "/api/subscriptions/sub_1", "/api/offers/off_1"] {
            assert_eq!(class(Method::GET, p), Class::Read, "{p}");
        }
    }

    #[test]
    fn a_bucket_allows_its_burst_then_one_per_interval() {
        let t0 = Instant::now();
        let mut b = Buckets::new(t0);
        let a = ip("203.0.113.7");
        let Rate { burst, every } = Class::Write.rate();
        for _ in 0..burst {
            b.take(a, Class::Write, t0).unwrap();
        }
        assert_eq!(b.take(a, Class::Write, t0), Err(every));
        assert_eq!(b.take(a, Class::Write, t0 + every / 2), Err(every / 2));
        b.take(a, Class::Write, t0 + every).unwrap();
        assert!(b.take(a, Class::Write, t0 + every).is_err());
        // Other classes and other clients have buckets of their own.
        b.take(a, Class::Read, t0).unwrap();
        b.take(a, Class::Pocket, t0).unwrap();
        b.take(ip("203.0.113.8"), Class::Write, t0).unwrap();
        // Idle for long enough, a bucket is full again.
        let later = t0 + every * (burst + 1);
        for _ in 0..burst {
            b.take(a, Class::Write, later).unwrap();
        }
        assert!(b.take(a, Class::Write, later).is_err());
    }

    #[test]
    fn idle_buckets_are_swept_and_a_flood_goes_uncounted() {
        let t0 = Instant::now();
        let mut b = Buckets::new(t0);
        for n in 0..10u32 {
            b.take(IpAddr::from(n.to_be_bytes()), Class::Read, t0).unwrap();
        }
        assert_eq!(b.len(), 10);
        // A minute on, each is long full again and is dropped by the next request.
        b.take(ip("198.51.100.1"), Class::Read, t0 + SWEEP_EVERY).unwrap();
        assert_eq!(b.len(), 1);

        let mut b = Buckets::new(t0);
        for n in 0..MAX_BUCKETS as u32 {
            b.take(IpAddr::from(n.to_be_bytes()), Class::Pocket, t0).unwrap();
        }
        let late = ip("198.51.100.2");
        for _ in 0..50 {
            b.take(late, Class::Pocket, t0).unwrap();
        }
        assert_eq!(b.len(), MAX_BUCKETS);
        // Every bucket still owes time, so a sweep frees nothing, but the map stays bounded.
        b.take(late, Class::Pocket, t0 + Duration::from_secs(2)).unwrap();
        assert_eq!(b.len(), MAX_BUCKETS);
    }

    #[test]
    fn the_client_is_the_peer_unless_the_proxy_is_trusted() {
        let peer: SocketAddr = "10.0.0.5:4242".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.7, 10.0.0.1"));
        assert_eq!(client_ip(&headers, Some(peer), false), ip("10.0.0.5"));
        assert_eq!(client_ip(&headers, Some(peer), true), ip("203.0.113.7"));
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9:5555"));
        assert_eq!(client_ip(&headers, Some(peer), true), ip("203.0.113.9"));
        headers.insert("x-forwarded-for", HeaderValue::from_static("not an address"));
        assert_eq!(client_ip(&headers, Some(peer), true), ip("10.0.0.5"));
        assert_eq!(client_ip(&HeaderMap::new(), None, true), ip("::"));

        // IPv6 counts by /64; an IPv4 address mapped into IPv6 counts as itself.
        let v6: SocketAddr = "[2001:db8:1:2:3:4:5:6]:443".parse().unwrap();
        assert_eq!(client_ip(&HeaderMap::new(), Some(v6), false), ip("2001:db8:1:2::"));
        let mapped: SocketAddr = "[::ffff:203.0.113.7]:443".parse().unwrap();
        assert_eq!(client_ip(&HeaderMap::new(), Some(mapped), false), ip("203.0.113.7"));
    }

    #[test]
    fn waits_round_up_to_whole_seconds() {
        assert_eq!(whole_secs(Duration::from_millis(1)), 1);
        assert_eq!(whole_secs(Duration::from_millis(6_000)), 6);
        assert_eq!(whole_secs(Duration::from_millis(6_001)), 7);
        assert_eq!(whole_secs(Duration::ZERO), 1);
    }

    fn from(peer: &str, mut req: Request<Body>) -> Request<Body> {
        req.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        req
    }

    fn bad_broadcast(token: Option<&str>) -> Request<Body> {
        let mut req = Request::post("/api/broadcast").header(header::CONTENT_TYPE, "application/json");
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        req.body(Body::from(json!({ "tx_hex": "zz" }).to_string())).unwrap()
    }

    #[tokio::test]
    async fn past_its_burst_a_client_gets_429_with_retry_after() {
        let api = router(test_app(false, None), None, vec![]);
        let burst = Class::Write.rate().burst;
        for _ in 0..burst {
            let (status, _, body) = send(&api, from("203.0.113.7:1000", bad_broadcast(None))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        }
        let (status, headers, body) = send(&api, from("203.0.113.7:1001", bad_broadcast(None))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(headers.get(header::RETRY_AFTER).unwrap(), "6");
        assert_eq!(body["error"], "too many requests; try again in 6 s");
        // Reads are counted apart, and so is every other client.
        let status_req = Request::get("/api/status").body(Body::empty()).unwrap();
        let (status, _, _) = send(&api, from("203.0.113.7:1002", status_req)).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = send(&api, from("203.0.113.8:1000", bad_broadcast(None))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // The merchant is never limited, but a wrong token counts like none.
        let (status, _, _) = send(&api, from("203.0.113.7:1003", bad_broadcast(Some(TOKEN)))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = send(&api, from("203.0.113.7:1004", bad_broadcast(Some("not-the-token")))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn a_page_elsewhere_can_read_how_long_to_wait() {
        let origin = "https://app.example";
        let api = router(test_app(false, None), None, vec![HeaderValue::from_static(origin)]);
        let mut answer = None;
        for _ in 0..=Class::Write.rate().burst {
            let mut req = bad_broadcast(None);
            req.headers_mut().insert(header::ORIGIN, HeaderValue::from_static(origin));
            answer = Some(send(&api, from("203.0.113.7:1000", req)).await);
        }
        let (status, headers, _) = answer.unwrap();
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(headers.get("access-control-allow-origin").unwrap(), origin);
        let exposed = headers.get("access-control-expose-headers").unwrap().to_str().unwrap();
        assert!(exposed.to_ascii_lowercase().contains("retry-after"), "{exposed}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_served_runner_counts_each_client_by_its_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let api = router(test_app(false, None), None, vec![]);
        // A clone shares the served router's buckets.
        let same = api.clone();
        tokio::spawn(async move {
            axum::serve(listener, api.into_make_service_with_connect_info::<SocketAddr>()).await
        });
        let burst = Class::Write.rate().burst;
        let answers = tokio::task::spawn_blocking(move || {
            let config = ureq::Agent::config_builder().http_status_as_error(false).build();
            let agent = ureq::Agent::new_with_config(config);
            (0..=burst)
                .map(|_| {
                    let res = agent
                        .post(&format!("http://{addr}/api/broadcast"))
                        .header("Content-Type", "application/json")
                        .send(r#"{"tx_hex":"zz"}"#)
                        .unwrap();
                    let retry = res.headers().get("retry-after").map(|v| v.to_str().unwrap().to_string());
                    (res.status().as_u16(), retry)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap();
        assert!(answers[..burst as usize].iter().all(|a| *a == (400, None)), "{answers:?}");
        assert_eq!(answers[burst as usize], (429, Some("6".into())));
        // They were counted as 127.0.0.1, the socket's peer.
        let (status, _, _) = send(&same, from("127.0.0.1:1", bad_broadcast(None))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        let (status, _, _) = send(&same, from("127.0.0.2:1", bad_broadcast(None))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn forwarded_clients_count_apart_only_when_trusted() {
        let forwarded = |hop: &str| {
            let mut req = bad_broadcast(None);
            req.headers_mut().insert("x-forwarded-for", HeaderValue::from_str(hop).unwrap());
            from("10.0.0.1:80", req)
        };
        let burst = Class::Write.rate().burst as usize;
        for (trusted, refused) in [(false, burst), (true, 0)] {
            let mut app = test_app(false, None);
            Arc::get_mut(&mut app).unwrap().cfg.trust_forwarded = trusted;
            let api = router(app, None, vec![]);
            let mut limited = 0;
            for n in 0..2 * burst {
                let (status, _, _) = send(&api, forwarded(&format!("203.0.113.{n}"))).await;
                limited += usize::from(status == StatusCode::TOO_MANY_REQUESTS);
            }
            assert_eq!(limited, refused, "trusted: {trusted}");
        }
    }

    #[tokio::test]
    async fn bodies_are_small_except_the_upload() {
        let api = router(test_app(false, None), None, vec![]);
        let big = |path: &str, size: usize| {
            let body = json!({ "tx_hex": "0".repeat(size), "offer_id": "off_x", "pocket_id": "pkt_x", "installments": [] });
            Request::post(path)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let (status, _, _) = send(&api, big("/api/broadcast", 60 * 1024)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _, _) = send(&api, big("/api/broadcast", 64 * 1024)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        let (status, _, _) = send(&api, big("/api/sandbox/cheat", 64 * 1024)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        // A ladder of sealed packages is large; this one is refused for its offer, not its size.
        let (status, _, body) = send(&api, big("/api/subscriptions", 4 << 20)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "unknown offer");
    }
}
