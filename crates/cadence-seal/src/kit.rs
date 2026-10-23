//! Recovery kits: the payer's cancel key, encrypted to a passphrase with age's
//! scrypt recipient. A web payer who closes the tab keeps the kit, and can later
//! cancel in the browser or with `cadence cancel` / `cadence sweep`.

use std::io::{Read, Write};

use age::secrecy::SecretString;

use crate::{Result, SealError};

/// scrypt work factor for new kits: about a second natively, a few in a browser.
/// It is fixed because a wasm32 worker cannot time itself to calibrate one.
pub const KIT_WORK_FACTOR: u8 = 17;

/// The largest work factor a kit may ask for when opened.
const MAX_KIT_WORK_FACTOR: u8 = 22;

/// A kit's plaintext never needs more than this.
const MAX_KIT_LEN: u64 = 1 << 20;

pub const MIN_PASSPHRASE_CHARS: usize = 8;

/// Whether `bytes` look like an age file, rather than a plaintext kit.
pub fn is_sealed_kit(bytes: &[u8]) -> bool {
    bytes.starts_with(b"age-encryption.org/v1\n")
}

pub fn seal_kit(plain: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(SealError::WeakPassphrase { min: MIN_PASSPHRASE_CHARS });
    }
    let mut recipient = age::scrypt::Recipient::new(SecretString::from(passphrase.to_owned()));
    recipient.set_work_factor(KIT_WORK_FACTOR);
    let encryptor = age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
    let mut out = vec![];
    let mut writer = encryptor.wrap_output(&mut out)?;
    writer.write_all(plain)?;
    writer.finish()?;
    Ok(out)
}

pub fn open_kit(sealed: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let decryptor = age::Decryptor::new(sealed).map_err(|e| SealError::Kit(e.to_string()))?;
    if !decryptor.is_scrypt() {
        return Err(SealError::Kit("not a passphrase-encrypted kit".into()));
    }
    let mut identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    identity.set_max_work_factor(MAX_KIT_WORK_FACTOR);
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| match e {
            age::DecryptError::DecryptionFailed | age::DecryptError::NoMatchingKeys => SealError::WrongPassphrase,
            e => SealError::Kit(e.to_string()),
        })?;
    let mut out = vec![];
    reader.take(MAX_KIT_LEN).read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_passphrase() {
        let kit = seal_kit(b"{\"seed_hex\":\"00\"}", "correct horse").unwrap();
        assert!(is_sealed_kit(&kit));
        assert_eq!(open_kit(&kit, "correct horse").unwrap(), b"{\"seed_hex\":\"00\"}");
        assert!(matches!(open_kit(&kit, "wrong horse!"), Err(SealError::WrongPassphrase)));
        assert!(matches!(seal_kit(b"x", "short"), Err(SealError::WeakPassphrase { .. })));
    }
}
