use serde::Serialize;

pub const CORE_RELEASE_VERSION: &str = match option_env!("MIA_CORE_RELEASE_VERSION") {
    Some(value) => value,
    None => "unverified",
};

pub const CORE_SOURCE_FINGERPRINT: &str = match option_env!("MIA_CORE_SOURCE_FINGERPRINT") {
    Some(value) => value,
    None => "unverified",
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreBuildInfo {
    pub release_version: &'static str,
    pub source_fingerprint: &'static str,
}

pub fn current() -> CoreBuildInfo {
    CoreBuildInfo {
        release_version: CORE_RELEASE_VERSION,
        source_fingerprint: CORE_SOURCE_FINGERPRINT,
    }
}
