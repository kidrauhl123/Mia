fn main() {
    println!("cargo:rerun-if-env-changed=MIA_CORE_RELEASE_VERSION");
    println!("cargo:rerun-if-env-changed=MIA_CORE_SOURCE_FINGERPRINT");
}
