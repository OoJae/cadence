//! Native comparison: runs the exact same bench code as the wasm build.
fn main() {
    let n: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(20);
    // warm-up (first call pays one-time generator/table setup)
    let _ = cadence_wasm_signer::run_bench(1).expect("warmup");
    let r = cadence_wasm_signer::run_bench(n).expect("bench");
    println!("rungs: {}", r.to_json());
    #[cfg(feature = "prove")]
    {
        let p = cadence_wasm_signer::prove::run_prove().expect("prove");
        println!("prove: {}", p.to_json());
    }
}
