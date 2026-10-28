//! Files holding a pocket seed, through the `cadence` binary: `pocket new` writes
//! them 0600, plain or encrypted to a passphrase, and the commands that read them
//! take either form. Nothing here touches the network.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

const PASSPHRASE: &str = "correct horse battery";

fn scratch(name: &str) -> PathBuf {
    let mut nonce = [0u8; 8];
    rand::fill(&mut nonce);
    let dir = std::env::temp_dir().join(format!("cadence-cli-{name}-{}", hex::encode(nonce)));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs `cadence` as a script would: no terminal on stdin and no passphrase in the
/// environment, except what `env` sets.
fn cadence(args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_cadence"));
    cmd.args(args).stdin(Stdio::null()).env_remove("CADENCE_KEY_PASSPHRASE").env_remove("CADENCE_KIT_PASSPHRASE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}

fn ok(out: Output) -> (String, String) {
    let (stdout, stderr) = (String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap());
    assert!(out.status.success(), "failed: {stderr}");
    (stdout, stderr)
}

fn err(out: Output) -> String {
    assert!(!out.status.success());
    String::from_utf8(out.stderr).unwrap()
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn funding_address(stdout: &str) -> &str {
    stdout.lines().find_map(|l| l.strip_prefix("funding address: ")).expect("a funding address")
}

fn is_age(bytes: &[u8]) -> bool {
    bytes.starts_with(b"age-encryption.org/v1\n")
}

#[test]
fn without_a_passphrase_a_script_gets_plain_json_at_0600_and_a_warning() {
    let dir = scratch("plain");
    let path = dir.join("pocket.json");
    let p = path.to_str().unwrap();
    let (made, warning) = ok(cadence(&["pocket", "new", "--network", "test", "--out", p], &[]));
    assert_eq!(warning.lines().count(), 1);
    assert!(warning.starts_with("warning: ") && warning.contains("unencrypted"), "{warning}");

    let bytes = fs::read(&path).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["network"], "test");
    assert_eq!(json["seed_hex"].as_str().unwrap().len(), 64);
    #[cfg(unix)]
    assert_eq!(mode(&path), 0o600);

    let (shown, _) = ok(cadence(&["pocket", "show", "--pocket", p], &[]));
    assert_eq!(funding_address(&shown), funding_address(&made));
    assert!(err(cadence(&["pocket", "new", "--out", p], &[])).contains("already exists"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_passphrase_file_or_the_environment_encrypts_it_and_every_reader_opens_it() {
    let dir = scratch("sealed");
    let pass = dir.join("pass");
    fs::write(&pass, format!("{PASSPHRASE}\n")).unwrap();
    let path = dir.join("pocket.age");
    let p = path.to_str().unwrap();
    let (made, quiet) = ok(cadence(&["pocket", "new", "--out", p, "--passphrase-file", pass.to_str().unwrap()], &[]));
    assert_eq!(quiet, "");

    let sealed = fs::read(&path).unwrap();
    assert!(is_age(&sealed));
    #[cfg(unix)]
    assert_eq!(mode(&path), 0o600);
    // Exactly the web app's cancel key format: it opens as a kit, to the pocket file.
    let plain: serde_json::Value = serde_json::from_slice(&cadence_seal::open_kit(&sealed, PASSPHRASE).unwrap()).unwrap();
    assert_eq!(plain["network"], "test");

    // Read back with either variable; a wrong passphrase is refused.
    for var in ["CADENCE_KEY_PASSPHRASE", "CADENCE_KIT_PASSPHRASE"] {
        let (shown, _) = ok(cadence(&["pocket", "show", "--pocket", p], &[(var, PASSPHRASE)]));
        assert_eq!(funding_address(&shown), funding_address(&made));
    }
    assert!(err(cadence(&["pocket", "show", "--pocket", p], &[("CADENCE_KIT_PASSPHRASE", "wrong horse battery")])).contains("wrong passphrase"));

    // CADENCE_KEY_PASSPHRASE alone encrypts too; a short one writes nothing.
    let env = dir.join("env.age");
    ok(cadence(&["pocket", "new", "--out", env.to_str().unwrap()], &[("CADENCE_KEY_PASSPHRASE", PASSPHRASE)]));
    assert!(is_age(&fs::read(&env).unwrap()));
    let short = dir.join("short.age");
    assert!(err(cadence(&["pocket", "new", "--out", short.to_str().unwrap()], &[("CADENCE_KEY_PASSPHRASE", "short")])).contains("at least 8"));
    assert!(!short.exists());
    fs::remove_dir_all(dir).unwrap();
}

/// A finished subscription file, as `subscribe` leaves it, on a local runner so that
/// nothing is dialled: `resume` reads it and stops at once, as it was uploaded.
#[test]
fn resume_reads_a_subscription_file_in_either_form() {
    let dir = scratch("resume");
    let file = serde_json::json!({
        "network": "test", "seed_hex": "2a".repeat(32), "runner": "http://127.0.0.1:9", "offer_id": "off_x",
        "pocket_id": "pkt_x", "subscription_id": "sub_x", "mandate_id": "00".repeat(16), "amount_zat": 20000,
        "count": 3, "period_secs": 300, "first_release_at": 0, "merchant_ua": "u1x",
        "funding_tx_hex": null, "funding_height": null
    });
    let plain = serde_json::to_vec_pretty(&file).unwrap();
    let forms = [("sub.json", plain.clone()), ("sub.age", cadence_seal::seal_kit(&plain, PASSPHRASE).unwrap())];
    for (name, bytes) in forms {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        let out = cadence(&["resume", "--subscription", path.to_str().unwrap()], &[("CADENCE_KEY_PASSPHRASE", PASSPHRASE)]);
        assert!(err(out).contains("already uploaded"), "{name}");
    }
    fs::remove_dir_all(dir).unwrap();
}
