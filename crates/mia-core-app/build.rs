fn main() {
    println!("cargo:rerun-if-env-changed=MIA_CORE_RELEASE_VERSION");
    println!("cargo:rerun-if-env-changed=MIA_CORE_SOURCE_FINGERPRINT");
    let release_version =
        std::env::var("MIA_CORE_RELEASE_VERSION").unwrap_or_else(|_| "unverified".to_string());
    let source_fingerprint =
        std::env::var("MIA_CORE_SOURCE_FINGERPRINT").unwrap_or_else(|_| "unverified".to_string());
    println!(
        "cargo:rustc-env=MIA_CORE_BUILD_INFO_MARKER=MIA_CORE_BUILD_INFO|{release_version}|{source_fingerprint}|"
    );
}
