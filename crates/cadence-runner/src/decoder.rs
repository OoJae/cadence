//! What `GET /api/decode/{txid}` keeps for itself, so that visitors decoding
//! transactions never hold up the scheduler: a lightwalletd connection the scheduler
//! does not use, a cap on decodes at once, and the shapes of mined transactions,
//! which never change.

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

use cadence_chain::lwd;
use serde_json::Value;
use tokio::sync::Semaphore;
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::BlockHeight;

/// Decodes that may ask lightwalletd at once; the rest wait their turn.
pub const DECODES_AT_ONCE: usize = 4;

/// Blocks a transaction must be under before its decoded shape is kept, so that a
/// reorg cannot change its mined height afterwards.
pub const CACHE_DEPTH: u32 = 10;

/// Shapes kept, the oldest dropped first.
pub const CACHE_SIZE: usize = 1024;

pub struct Decoder {
    /// A channel of its own (in production, its own Tor circuit), apart from the one
    /// the scheduler syncs over.
    pub client: lwd::Client,
    pub permits: Semaphore,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    shapes: HashMap<TxId, Value>,
    /// Oldest first.
    order: VecDeque<TxId>,
}

impl Decoder {
    pub fn new(client: lwd::Client) -> Self {
        Decoder { client, permits: Semaphore::new(DECODES_AT_ONCE), cache: Mutex::default() }
    }

    pub fn cached(&self, txid: &TxId) -> Option<Value> {
        self.cache.lock().unwrap().shapes.get(txid).cloned()
    }

    /// Keeps `shape` if its transaction is mined at least [`CACHE_DEPTH`] blocks below `tip`.
    pub fn remember(&self, txid: TxId, shape: &Value, mined: Option<BlockHeight>, tip: u32) {
        if mined.is_none_or(|h| u32::from(h).saturating_add(CACHE_DEPTH) > tip) {
            return;
        }
        let mut cache = self.cache.lock().unwrap();
        if cache.shapes.contains_key(&txid) {
            return;
        }
        if cache.order.len() == CACHE_SIZE {
            if let Some(oldest) = cache.order.pop_front() {
                cache.shapes.remove(&oldest);
            }
        }
        cache.order.push_back(txid);
        cache.shapes.insert(txid, shape.clone());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;

    use super::*;

    fn decoder() -> Decoder {
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:9").connect_lazy();
        Decoder::new(CompactTxStreamerClient::new(channel))
    }

    fn txid(n: u32) -> TxId {
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&n.to_le_bytes());
        TxId::from_bytes(bytes)
    }

    #[tokio::test]
    async fn only_shapes_deep_enough_are_kept() {
        let d = decoder();
        let shape = json!({ "mined_height": 100 });
        let at = |h| Some(BlockHeight::from_u32(h));
        d.remember(txid(1), &shape, None, 1_000);
        d.remember(txid(2), &shape, at(100), 109);
        assert!(d.cached(&txid(1)).is_none(), "a mempool transaction can still change");
        assert!(d.cached(&txid(2)).is_none(), "nine blocks deep can still be reorged");
        d.remember(txid(2), &shape, at(100), 110);
        assert_eq!(d.cached(&txid(2)), Some(shape.clone()));
        // The first shape kept stays.
        d.remember(txid(2), &json!({ "other": true }), at(100), 200);
        assert_eq!(d.cached(&txid(2)), Some(shape));
    }

    #[tokio::test]
    async fn the_oldest_shape_goes_first() {
        let d = decoder();
        let mined = Some(BlockHeight::from_u32(1));
        for n in 0..CACHE_SIZE as u32 + 2 {
            d.remember(txid(n), &json!(n), mined, 100);
        }
        assert!(d.cached(&txid(0)).is_none());
        assert!(d.cached(&txid(1)).is_none());
        assert_eq!(d.cached(&txid(2)), Some(json!(2)));
        assert_eq!(d.cached(&txid(CACHE_SIZE as u32 + 1)), Some(json!(CACHE_SIZE + 1)));
        let cache = d.cache.lock().unwrap();
        assert_eq!((cache.shapes.len(), cache.order.len()), (CACHE_SIZE, CACHE_SIZE));
    }
}
