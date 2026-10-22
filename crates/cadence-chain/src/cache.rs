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
