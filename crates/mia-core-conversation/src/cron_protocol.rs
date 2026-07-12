#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CronCommand {
    Create(CronCreateParams),
    Update(CronUpdateParams),
    List,
    Delete(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronCreateParams {
    pub name: String,
    pub schedule: String,
    pub schedule_description: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronUpdateParams {
    pub job_id: String,
    pub name: String,
    pub schedule: String,
    pub schedule_description: String,
    pub message: String,
}

#[derive(Default)]
struct CommandFields {
    name: String,
    schedule: String,
    schedule_description: String,
    message: String,
}

pub fn detect_cron_commands(text: &str) -> Vec<CronCommand> {
    let mut commands = Vec::new();

    for (_, _, body) in tagged_blocks(text, "[CRON_CREATE]", "[/CRON_CREATE]") {
        if let Some(fields) = parse_command_fields(body) {
            commands.push(CronCommand::Create(CronCreateParams {
                name: fields.name,
                schedule: fields.schedule,
                schedule_description: fields.schedule_description,
                message: fields.message,
            }));
        }
    }

    for (header_start, body_start, body) in update_blocks(text) {
        let header = &text[header_start..body_start];
        let Some(job_id) = header
            .strip_prefix("[CRON_UPDATE:")
            .and_then(|value| value.strip_suffix(']'))
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if let Some(fields) = parse_command_fields(body) {
            commands.push(CronCommand::Update(CronUpdateParams {
                job_id: job_id.to_string(),
                name: fields.name,
                schedule: fields.schedule,
                schedule_description: fields.schedule_description,
                message: fields.message,
            }));
        }
    }

    if text.contains("[CRON_LIST]") {
        commands.push(CronCommand::List);
    }

    for (_, _, job_id) in inline_commands(text, "[CRON_DELETE:") {
        commands.push(CronCommand::Delete(job_id.to_string()));
    }

    commands
}

pub fn has_cron_commands(text: &str) -> bool {
    !detect_cron_commands(text).is_empty()
}

pub fn strip_cron_commands(text: &str) -> String {
    let mut ranges = Vec::new();
    ranges.extend(
        tagged_blocks(text, "[CRON_CREATE]", "[/CRON_CREATE]")
            .into_iter()
            .map(|(start, end, _)| (start, end)),
    );
    ranges.extend(update_blocks(text).into_iter().filter_map(|(start, _, _)| {
        text[start..]
            .find("[/CRON_UPDATE]")
            .map(|offset| (start, start + offset + "[/CRON_UPDATE]".len()))
    }));
    ranges.extend(
        exact_token_ranges(text, "[CRON_LIST]").into_iter().chain(
            inline_commands(text, "[CRON_DELETE:")
                .into_iter()
                .map(|(start, end, _)| (start, end)),
        ),
    );
    remove_ranges(text, ranges)
}

fn parse_command_fields(body: &str) -> Option<CommandFields> {
    let mut fields = CommandFields::default();
    let mut in_message = false;
    let mut message_lines = Vec::new();

    for raw_line in body.lines() {
        let line = raw_line.trim();
        if in_message {
            message_lines.push(line.to_string());
            continue;
        }
        if let Some(value) = line.strip_prefix("name:") {
            fields.name = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("schedule_description:") {
            fields.schedule_description = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("schedule:") {
            fields.schedule = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("message:") {
            in_message = true;
            message_lines.push(value.trim().to_string());
        }
    }

    while message_lines.last().is_some_and(|line| line.is_empty()) {
        message_lines.pop();
    }
    fields.message = message_lines.join("\n");
    if [
        &fields.name,
        &fields.schedule,
        &fields.schedule_description,
        &fields.message,
    ]
    .into_iter()
    .any(|value| value.trim().is_empty())
    {
        return None;
    }
    Some(fields)
}

fn tagged_blocks<'a>(text: &'a str, open: &str, close: &str) -> Vec<(usize, usize, &'a str)> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some(open_offset) = text[cursor..].find(open) {
        let start = cursor + open_offset;
        let body_start = start + open.len();
        let Some(close_offset) = text[body_start..].find(close) else {
            break;
        };
        let close_start = body_start + close_offset;
        let end = close_start + close.len();
        blocks.push((start, end, text[body_start..close_start].trim()));
        cursor = end;
    }
    blocks
}

fn update_blocks(text: &str) -> Vec<(usize, usize, &str)> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some(open_offset) = text[cursor..].find("[CRON_UPDATE:") {
        let start = cursor + open_offset;
        let Some(header_end_offset) = text[start..].find(']') else {
            break;
        };
        let body_start = start + header_end_offset + 1;
        let Some(close_offset) = text[body_start..].find("[/CRON_UPDATE]") else {
            break;
        };
        let close_start = body_start + close_offset;
        blocks.push((start, body_start, text[body_start..close_start].trim()));
        cursor = close_start + "[/CRON_UPDATE]".len();
    }
    blocks
}

fn inline_commands<'a>(text: &'a str, prefix: &str) -> Vec<(usize, usize, &'a str)> {
    let mut commands = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find(prefix) {
        let start = cursor + offset;
        let value_start = start + prefix.len();
        let Some(close_offset) = text[value_start..].find(']') else {
            break;
        };
        let end = value_start + close_offset + 1;
        let value = text[value_start..end - 1].trim();
        if !value.is_empty() {
            commands.push((start, end, value));
        }
        cursor = end;
    }
    commands
}

fn exact_token_ranges(text: &str, token: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find(token) {
        let start = cursor + offset;
        let end = start + token.len();
        ranges.push((start, end));
        cursor = end;
    }
    ranges
}

fn remove_ranges(text: &str, mut ranges: Vec<(usize, usize)>) -> String {
    ranges.sort_unstable();
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        if start < cursor || end > text.len() {
            continue;
        }
        output.push_str(&text[cursor..start]);
        cursor = end;
    }
    output.push_str(&text[cursor..]);
    output
}
