use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{error, BlockCache, BlockSource},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

/// An in-memory compact block cache for [`zcash_client_backend::sync::run`].
///
/// The runner scans a handful of recent blocks per pocket, so nothing needs to
/// persist between runs.
#[derive(Clone, Default)]
pub struct MemBlockCache {
    blocks: Arc<Mutex<BTreeMap<BlockHeight, CompactBlock>>>,
}

#[derive(Debug)]
pub struct CacheError(String);

impl fmt::Display for CacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "block cache: {}", self.0)
    }
}

impl std::error::Error for CacheError {}

fn height_of(block: &CompactBlock) -> BlockHeight {
    BlockHeight::from_u32(block.height as u32)
}

impl BlockSource for MemBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        let blocks: Vec<CompactBlock> = {
            let cached = self.blocks.lock().unwrap();
            let start = from_height.unwrap_or(BlockHeight::from_u32(0));
            cached
                .range(start..)
                .take(limit.unwrap_or(usize::MAX))
                .map(|(_, b)| b.clone())
                .collect()
        };
        for block in blocks {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let cached = self.blocks.lock().unwrap();
        Ok(match range {
            Some(range) => cached.range(range.block_range().clone()).next_back().map(|(h, _)| *h),
            None => cached.keys().next_back().copied(),
        })
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        Ok(self
            .blocks
            .lock()
            .unwrap()
            .range(range.block_range().clone())
            .map(|(_, b)| b.clone())
            .collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut cached = self.blocks.lock().unwrap();
        for block in compact_blocks {
            cached.insert(height_of(&block), block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.blocks
            .lock()
            .unwrap()
            .retain(|h, _| !range.block_range().contains(h));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use zcash_client_backend::data_api::scanning::ScanPriority;

    use super::*;

    fn block(height: u32) -> CompactBlock {
        CompactBlock { height: u64::from(height), ..Default::default() }
    }

    fn at(height: u32) -> BlockHeight {
        BlockHeight::from_u32(height)
    }

    fn range(start: u32, end: u32) -> ScanRange {
        ScanRange::from_parts(at(start)..at(end), ScanPriority::Historic)
    }

    fn heights(blocks: &[CompactBlock]) -> Vec<u64> {
        blocks.iter().map(|b| b.height).collect()
    }

    #[tokio::test]
    async fn blocks_come_back_by_height_within_a_range() {
        let cache = MemBlockCache::default();
        assert_eq!(cache.get_tip_height(None).unwrap(), None);
        cache.insert(vec![block(12), block(10), block(11), block(14)]).await.unwrap();
        assert_eq!(cache.get_tip_height(None).unwrap(), Some(at(14)));
        // Ranges are half-open, as scan ranges are.
        assert_eq!(cache.get_tip_height(Some(&range(10, 14))).unwrap(), Some(at(12)));
        assert_eq!(cache.get_tip_height(Some(&range(15, 20))).unwrap(), None);
        assert_eq!(heights(&cache.read(&range(11, 14)).await.unwrap()), [11, 12]);

        // A clone is the same cache.
        let shared = cache.clone();
        shared.delete(range(11, 13)).await.unwrap();
        assert_eq!(heights(&cache.read(&range(0, 100)).await.unwrap()), [10, 14]);
        // A block at a height already held replaces it.
        let mut again = block(10);
        again.hash = vec![1];
        cache.insert(vec![again]).await.unwrap();
        let blocks = cache.read(&range(10, 11)).await.unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].hash, [1]);
    }

    #[tokio::test]
    async fn the_block_source_starts_at_a_height_and_stops_at_a_limit() {
        let cache = MemBlockCache::default();
        cache.insert((10..20).map(block).collect()).await.unwrap();
        let walk = |from: Option<u32>, limit: Option<usize>| {
            let mut seen = vec![];
            cache
                .with_blocks::<_, ()>(from.map(at), limit, |b| {
                    seen.push(b.height);
                    Ok(())
                })
                .unwrap();
            seen
        };
        assert_eq!(walk(None, None), (10..20).collect::<Vec<u64>>());
        assert_eq!(walk(Some(17), None), [17, 18, 19]);
        assert_eq!(walk(Some(12), Some(2)), [12, 13]);
        assert!(walk(Some(25), None).is_empty());

        // An error from the callback ends the walk.
        let mut seen = vec![];
        let result = cache.with_blocks::<_, &str>(None, None, |b| {
            seen.push(b.height);
            if b.height == 11 {
                return Err(error::Error::Wallet("stop"));
            }
            Ok(())
        });
        assert!(matches!(result, Err(error::Error::Wallet("stop"))));
        assert_eq!(seen, [10, 11]);
    }
}
