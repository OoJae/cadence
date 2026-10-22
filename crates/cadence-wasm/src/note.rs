//! A compact, self-contained encoding of an Orchard-family note.
//!
//! The browser keeps the pocket's notes (the funding note `F` and each change note
//! `C(k)`) between calls, and hands them to whichever worker signs next. A note is
//! rebuilt with `Note::from_parts`, so the encoding carries exactly those parts:
//!
//! ```text
//! note = version (1) || recipient (43, raw) || value (8, u64 LE) || rho (32) || rseed (32)
//! ```
//!
//! 116 bytes, 232 hex characters. `version` is the note plaintext lead byte
//! (`0x02` Orchard, `0x03` Ironwood). Decoding checks every part (a valid
//! recipient, canonical `rho`, an `rseed` that yields a note commitment), so a
//! malformed encoding fails here rather than inside the builder. An encoding that
//! is altered but still well formed decodes to a different note, whose nullifier
//! then matches nothing the pocket owns.
//!
//! The encoding is secret: `rseed` and `rho` with the recipient open the note.

use orchard::{
    note::{Note, NoteVersion, RandomSeed, Rho},
    value::NoteValue,
    Address,
};

use crate::Error;

/// Length of an encoded note, in bytes.
pub const NOTE_LEN: usize = 1 + 43 + 8 + 32 + 32;

pub fn encode(note: &Note) -> [u8; NOTE_LEN] {
    let mut out = [0u8; NOTE_LEN];
    out[0] = match note.version() {
        NoteVersion::V2 => 0x02,
        NoteVersion::V3 => 0x03,
    };
    out[1..44].copy_from_slice(&note.recipient().to_raw_address_bytes());
    out[44..52].copy_from_slice(&note.value().inner().to_le_bytes());
    out[52..84].copy_from_slice(&note.rho().to_bytes());
    out[84..116].copy_from_slice(note.rseed().as_bytes());
    out
}

pub fn encode_hex(note: &Note) -> String {
    hex::encode(encode(note))
}

pub fn decode(bytes: &[u8]) -> Result<Note, Error> {
    let bad = |why: &str| Error::Note(why.to_string());
    if bytes.len() != NOTE_LEN {
        return Err(bad("a note is 116 bytes"));
    }
    let version = match bytes[0] {
        0x02 => NoteVersion::V2,
        0x03 => NoteVersion::V3,
        _ => return Err(bad("unknown note version")),
    };
    let recipient: [u8; 43] = bytes[1..44].try_into().expect("43 bytes");
    let recipient =
        Option::<Address>::from(Address::from_raw_address_bytes(&recipient)).ok_or_else(|| bad("bad recipient"))?;
    let value = u64::from_le_bytes(bytes[44..52].try_into().expect("8 bytes"));
    let rho: [u8; 32] = bytes[52..84].try_into().expect("32 bytes");
    let rho = Option::<Rho>::from(Rho::from_bytes(&rho)).ok_or_else(|| bad("bad rho"))?;
    let rseed: [u8; 32] = bytes[84..116].try_into().expect("32 bytes");
    let rseed = Option::<RandomSeed>::from(RandomSeed::from_bytes(rseed, &rho)).ok_or_else(|| bad("bad rseed"))?;
    Option::from(Note::from_parts(recipient, NoteValue::from_raw(value), rho, rseed, version))
        .ok_or_else(|| bad("the parts do not form a valid note"))
}

pub fn decode_hex(text: &str) -> Result<Note, Error> {
    let bytes = hex::decode(text.trim()).map_err(|_| Error::Note("a note is hex".into()))?;
    decode(&bytes)
}
