//! Files that hold a pocket seed: pocket files (`pocket new`) and subscription files
//! (`subscribe`, `resume`). Each is written atomically and readable by its owner only
//! (0600), either encrypted to a passphrase in the web app's cancel key format (age,
//! scrypt: `cadence_seal::seal_kit`) or, for scripts that give none, as plain JSON.

use std::{
    fs,
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{anyhow, bail, Context, Result};

/// How a seed file is written.
#[derive(Clone)]
pub enum Lock {
    Plain,
    Passphrase(String),
}

/// Every seed file this command has read, created or saved: how it is written back
/// and, once known, its plaintext. A passphrase is asked for once per file however
/// often the command reads or saves it.
static FILES: Mutex<Vec<(PathBuf, Lock, Option<Vec<u8>>)>> = Mutex::new(vec![]);

/// How to protect a new seed file: the passphrase in `passphrase_file`, else
/// `CADENCE_KEY_PASSPHRASE`, else one typed twice at the terminal. With none of these
/// and no terminal on stdin, the seed is written as plain JSON, with a warning, so
/// existing scripts keep working.
pub fn choose(passphrase_file: Option<&Path>) -> Result<Lock> {
    let given = match passphrase_file {
        Some(file) => {
            let text = fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?;
            Some(text.trim_end_matches(['\r', '\n']).to_string())
        }
        None => std::env::var("CADENCE_KEY_PASSPHRASE").ok(),
    };
    if let Some(passphrase) = given {
        // Refuse a weak one now, before a subscribe registers a pocket it cannot save.
        if passphrase.chars().count() < cadence_seal::MIN_PASSPHRASE_CHARS {
            bail!("the passphrase must have at least {} characters", cadence_seal::MIN_PASSPHRASE_CHARS);
        }
        return Ok(Lock::Passphrase(passphrase));
    }
    if !std::io::stdin().is_terminal() {
        eprintln!("warning: no --passphrase-file or CADENCE_KEY_PASSPHRASE, so the pocket seed is written unencrypted");
        return Ok(Lock::Plain);
    }
    loop {
        let passphrase = rpassword::prompt_password("passphrase to encrypt the pocket seed: ")?;
        if passphrase.chars().count() < cadence_seal::MIN_PASSPHRASE_CHARS {
            eprintln!("it must have at least {} characters", cadence_seal::MIN_PASSPHRASE_CHARS);
            continue;
        }
        if rpassword::prompt_password("the same passphrase again: ")? == passphrase {
            return Ok(Lock::Passphrase(passphrase));
        }
        eprintln!("the two differ; try again");
    }
}

/// Sets how [`write`] protects `path`, a seed file this command creates.
pub fn protect(path: &Path, lock: Lock) {
    let mut files = FILES.lock().unwrap();
    files.retain(|(p, ..)| p != path);
    files.push((path.to_path_buf(), lock, None));
}

/// Reads a seed file, plain or encrypted. An encrypted one (a cancel key saved by the
/// web app, or a file written with a passphrase) opens with `CADENCE_KIT_PASSPHRASE`
/// or `CADENCE_KEY_PASSPHRASE`, or a passphrase asked for.
pub fn read(path: &Path) -> Result<Vec<u8>> {
    let mut files = FILES.lock().unwrap();
    if let Some((_, _, Some(plain))) = files.iter().find(|(p, ..)| p == path) {
        return Ok(plain.clone());
    }
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let (lock, plain) = if cadence_seal::is_sealed_kit(&bytes) {
        let passphrase = match std::env::var("CADENCE_KIT_PASSPHRASE").or_else(|_| std::env::var("CADENCE_KEY_PASSPHRASE")) {
            Ok(p) => p,
            Err(_) => rpassword::prompt_password(format!("passphrase for {}: ", path.display()))?,
        };
        let plain = cadence_seal::open_kit(&bytes, &passphrase).map_err(|e| anyhow!("{e}"))?;
        (Lock::Passphrase(passphrase), plain)
    } else {
        (Lock::Plain, bytes)
    };
    files.retain(|(p, ..)| p != path);
    files.push((path.to_path_buf(), lock, Some(plain.clone())));
    Ok(plain)
}

/// Writes `plain` to the seed file `path` as [`protect`] chose or, for a file this
/// command read, in the form it was read in.
pub fn write(path: &Path, plain: &[u8]) -> Result<()> {
    let mut files = FILES.lock().unwrap();
    let entry = files
        .iter_mut()
        .find(|(p, ..)| p == path)
        .with_context(|| format!("no protection chosen for {}", path.display()))?;
    let bytes = match &entry.1 {
        Lock::Plain => plain.to_vec(),
        Lock::Passphrase(passphrase) => cadence_seal::seal_kit(plain, passphrase).map_err(|e| anyhow!("{e}"))?,
    };
    write_private(path, &bytes)?;
    entry.2 = Some(plain.to_vec());
    Ok(())
}

/// Replaces `path` with `bytes` in one step: a 0600 temporary file in the same
/// directory, synced, then renamed over it. A crash leaves the old file or the new
/// one, never part of either, and no one else can read either.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    fs::create_dir_all(dir)?;
    let name = path.file_name().with_context(|| format!("{} is not a file path", path.display()))?;
    let mut nonce = [0u8; 8];
    rand::fill(&mut nonce);
    let tmp = dir.join(format!(".{}.{}.tmp", name.to_string_lossy(), hex::encode(nonce)));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let mut nonce = [0u8; 8];
        rand::fill(&mut nonce);
        let dir = std::env::temp_dir().join(format!("cadence-keyfile-{name}-{}", hex::encode(nonce)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// The names in `dir`, sorted: a temporary file left behind would show here.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn plain_files_are_0600_and_replace_a_world_readable_one() {
        let dir = scratch("plain");
        let path = dir.join("pocket.json");
        fs::write(&path, b"old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        protect(&path, Lock::Plain);
        write(&path, br#"{"seed_hex":"00"}"#).unwrap();
        assert_eq!(fs::read(&path).unwrap(), br#"{"seed_hex":"00"}"#);
        #[cfg(unix)]
        assert_eq!(mode(&path), 0o600);
        assert_eq!(names(&dir), ["pocket.json"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_passphrase_file_encrypts_to_the_web_kit_format_and_reads_back() {
        let dir = scratch("sealed");
        let pass = dir.join("pass");
        fs::write(&pass, "correct horse battery\n").unwrap();
        let lock = choose(Some(&pass)).unwrap();
        assert!(matches!(&lock, Lock::Passphrase(p) if p == "correct horse battery"));

        let path = dir.join("sub.json");
        protect(&path, lock);
        write(&path, br#"{"seed_hex":"01"}"#).unwrap();
        let sealed = fs::read(&path).unwrap();
        assert!(cadence_seal::is_sealed_kit(&sealed));
        assert!(!sealed.windows(8).any(|w| w == b"seed_hex"));
        #[cfg(unix)]
        assert_eq!(mode(&path), 0o600);
        // As the web app opens a cancel key, and as a later command reads it.
        assert_eq!(cadence_seal::open_kit(&sealed, "correct horse battery").unwrap(), br#"{"seed_hex":"01"}"#);
        FILES.lock().unwrap().retain(|(p, ..)| p != &path);
        std::env::set_var("CADENCE_KEY_PASSPHRASE", "correct horse battery");
        assert_eq!(read(&path).unwrap(), br#"{"seed_hex":"01"}"#);
        std::env::remove_var("CADENCE_KEY_PASSPHRASE");

        // A rewrite keeps the form it was read in.
        write(&path, br#"{"seed_hex":"02"}"#).unwrap();
        assert_eq!(cadence_seal::open_kit(&fs::read(&path).unwrap(), "correct horse battery").unwrap(), br#"{"seed_hex":"02"}"#);
        assert_eq!(names(&dir), ["pass", "sub.json"]);

        fs::write(&pass, "short\n").unwrap();
        assert!(choose(Some(&pass)).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
