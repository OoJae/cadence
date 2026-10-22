use std::path::Path;

use anyhow::{anyhow, bail, Result};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, ChainSpec, RawTransaction,
    TreeState, TxFilter,
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::consensus::{BlockHeight, BranchId, Parameters};

pub type Client = CompactTxStreamerClient<Channel>;

/// How a Cadence process reaches lightwalletd.
pub enum Transport<'a> {
    /// Over Tor via the embedded arti client; `dir` holds arti's state.
    Tor { dir: &'a Path },
    /// Plain TLS. Development only: the server learns this process's IP address.
    Direct,
}

pub async fn connect(server: &str, transport: Transport<'_>) -> Result<Client> {
    match transport {
        Transport::Direct => {
            let endpoint = Endpoint::from_shared(server.to_string())?
                .tls_config(ClientTlsConfig::new().with_webpki_roots())?;
            Ok(CompactTxStreamerClient::new(endpoint.connect().await?))
        }
        Transport::Tor { dir } => {
            std::fs::create_dir_all(dir)?;
            let tor = zcash_client_backend::tor::Client::create(dir, |_| {})
                .await
                .map_err(|e| anyhow!("bootstrapping Tor: {e:?}"))?;
            tor.connect_to_lightwalletd(server.parse()?, false)
                .await
                .map_err(|e| anyhow!("connecting to lightwalletd over Tor: {e:?}"))
        }
    }
}

pub async fn tip(client: &mut Client) -> Result<BlockHeight> {
    let block = client.get_latest_block(ChainSpec {}).await?.into_inner();
    Ok(BlockHeight::from_u32(u32::try_from(block.height)?))
}

pub async fn tree_state(client: &mut Client, height: BlockHeight) -> Result<TreeState> {
    let id = BlockId {
        height: u64::from(u32::from(height)),
        hash: vec![],
    };
    Ok(client.get_tree_state(id).await?.into_inner())
}

/// Fetches a transaction's raw bytes and mined height (`None` while in the mempool).
pub async fn raw_transaction(client: &mut Client, txid: &TxId) -> Result<(Vec<u8>, Option<BlockHeight>)> {
    let filter = TxFilter {
        block: None,
        index: 0,
        hash: txid.as_ref().to_vec(),
    };
    let raw = client.get_transaction(filter).await?.into_inner();
    let mined = u32::try_from(raw.height)
        .ok()
        .filter(|h| *h != 0)
        .map(BlockHeight::from_u32);
    Ok((raw.data, mined))
}

/// Fetches and parses a transaction, returning it with its mined height
/// (`None` while it is in the mempool).
pub async fn transaction<P: Parameters>(
    client: &mut Client,
    params: &P,
    txid: &TxId,
) -> Result<(Transaction, Option<BlockHeight>)> {
    let filter = TxFilter {
        block: None,
        index: 0,
        hash: txid.as_ref().to_vec(),
    };
    let raw = client.get_transaction(filter).await?.into_inner();
    // lightwalletd reports a mempool transaction with height 0 (or u64::MAX on some servers).
    let mined = u32::try_from(raw.height)
        .ok()
        .filter(|h| *h != 0)
        .map(BlockHeight::from_u32);
    let branch_height = match mined {
        Some(h) => h,
        None => tip(client).await? + 1,
    };
    let tx = Transaction::read(&raw.data[..], BranchId::for_height(params, branch_height))?;
    Ok((tx, mined))
}

/// Submits a serialized transaction. This reveals the transaction (not its contents)
/// to the server, so production callers use a different server, over an isolated
/// Tor circuit, from the one they sync from.
pub async fn send(client: &mut Client, tx_bytes: Vec<u8>) -> Result<()> {
    let response = client
        .send_transaction(RawTransaction {
            data: tx_bytes,
            height: 0,
        })
        .await?
        .into_inner();
    if response.error_code != 0 {
        bail!(
            "lightwalletd rejected the transaction ({}): {}",
            response.error_code,
            response.error_message
        );
    }
    Ok(())
}
