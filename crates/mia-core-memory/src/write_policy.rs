//! Central safety policy for durable Mia memory writes.

pub const POLICY_PROMPT_OVERRIDE: &str = "prompt_override";
pub const POLICY_CREDENTIAL_MATERIAL: &str = "credential_material";
pub const POLICY_SSH_BACKDOOR: &str = "ssh_backdoor";
pub const POLICY_PERSISTENT_COMMAND: &str = "persistent_command";
pub const POLICY_INVISIBLE_UNICODE: &str = "invisible_unicode";
pub const POLICY_INVALID_SEPARATOR: &str = "invalid_separator";

const INVISIBLE_CODE_POINTS: &[char] = &[
    '\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{feff}', '\u{202a}', '\u{202b}', '\u{202c}',
    '\u{202d}', '\u{202e}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
];

pub fn validate_memory_write(text: &str) -> Result<(), &'static str> {
    if text.lines().any(|line| line.trim() == "§") {
        return Err(POLICY_INVALID_SEPARATOR);
    }
    if text.chars().any(|ch| INVISIBLE_CODE_POINTS.contains(&ch)) {
        return Err(POLICY_INVISIBLE_UNICODE);
    }

    let lower = text.to_lowercase();
    if contains_any(
        &lower,
        &[
            "ignore system instructions",
            "ignore the system instructions",
            "ignore developer instructions",
            "ignore the developer instructions",
            "ignore previous instructions",
            "ignore all previous instructions",
            "忽略 system",
            "忽略之前的 system",
            "忽略先前的 system",
            "忽略 developer",
            "忽略系统指令",
            "忽略系统提示",
            "忽略开发者指令",
            "忽略之前的指令",
            "忽略先前指令",
            "无视系统指令",
            "无视开发者指令",
            "<system",
            "</system",
            "<developer",
            "</developer",
            "[system]",
            "[developer]",
        ],
    ) {
        return Err(POLICY_PROMPT_OVERRIDE);
    }

    if contains_any(
        &lower,
        &[
            "authorized_keys",
            "ssh-rsa",
            "ssh-ed25519",
            "~/.ssh",
            "permitrootlogin",
        ],
    ) {
        return Err(POLICY_SSH_BACKDOOR);
    }

    let pipe_to_shell = (lower.contains("curl ") || lower.contains("wget "))
        && contains_any(&lower, &["| sh", "|sh", "| bash", "|bash", "| zsh", "|zsh"]);
    if pipe_to_shell
        || contains_any(
            &lower,
            &[
                "crontab ",
                "launchctl load",
                "launchctl bootstrap",
                "systemctl enable",
                ">> ~/.bashrc",
                ">> ~/.zshrc",
                ">> ~/.profile",
                "> ~/.bashrc",
                "> ~/.zshrc",
                "> ~/.profile",
            ],
        )
    {
        return Err(POLICY_PERSISTENT_COMMAND);
    }

    if contains_any(
        &lower,
        &[
            "api key",
            "api_key",
            "apikey",
            "api secret",
            "client secret",
            "client_secret",
            "secret=",
            "secret:",
            "bearer ",
            "password",
            "passwd",
            "private key",
            "-----begin private key-----",
            "-----begin rsa private key-----",
            "-----begin openssh private key-----",
            "access_token",
            "refresh_token",
            "密码",
            "口令",
            "私钥",
        ],
    ) {
        return Err(POLICY_CREDENTIAL_MATERIAL);
    }

    Ok(())
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_every_directional_and_zero_width_code_point() {
        for ch in INVISIBLE_CODE_POINTS {
            assert_eq!(
                validate_memory_write(&format!("safe{ch}text")),
                Err(POLICY_INVISIBLE_UNICODE)
            );
        }
    }
}
