use mia_core_conversation::cron_protocol::{
    CronCommand, CronCreateParams, CronUpdateParams, detect_cron_commands, strip_cron_commands,
};

#[test]
fn detects_aion_cron_commands_and_preserves_multiline_message() {
    let text = r#"[CRON_CREATE]
name: 每日 AI 简报
schedule: 0 9 * * *
schedule_description: 每天上午 9 点
message: 搜索最近一天的重要 AI 新闻。
  按来源、影响和下一步行动分组。
  不要重复昨天的内容。
[/CRON_CREATE]"#;

    assert_eq!(
        detect_cron_commands(text),
        vec![CronCommand::Create(CronCreateParams {
            name: "每日 AI 简报".into(),
            schedule: "0 9 * * *".into(),
            schedule_description: "每天上午 9 点".into(),
            message:
                "搜索最近一天的重要 AI 新闻。\n按来源、影响和下一步行动分组。\n不要重复昨天的内容。"
                    .into(),
        })]
    );
}

#[test]
fn detects_list_update_and_delete_commands() {
    let text = r#"[CRON_LIST]
[CRON_UPDATE: task_123]
name: 新标题
schedule: 30 8 * * 1-5
schedule_description: 工作日上午 8:30
message: 输出今天的待办。
[/CRON_UPDATE]
[CRON_DELETE: task_456]"#;

    assert_eq!(
        detect_cron_commands(text),
        vec![
            CronCommand::Update(CronUpdateParams {
                job_id: "task_123".into(),
                name: "新标题".into(),
                schedule: "30 8 * * 1-5".into(),
                schedule_description: "工作日上午 8:30".into(),
                message: "输出今天的待办。".into(),
            }),
            CronCommand::List,
            CronCommand::Delete("task_456".into()),
        ]
    );
}

#[test]
fn ignores_unclosed_or_incomplete_mutating_commands() {
    assert!(detect_cron_commands("[CRON_CREATE]\nschedule: 0 9 * * *").is_empty());
    assert!(
        detect_cron_commands("[CRON_UPDATE: task_1]\nname: x\nschedule: 0 9 * * *\n[/CRON_UPDATE]")
            .is_empty()
    );
}

#[test]
fn strips_only_valid_cron_protocol_from_visible_assistant_text() {
    let text = "好的。\n[CRON_LIST]\n[CRON_DELETE: task_1]\n已经处理。";
    assert_eq!(strip_cron_commands(text), "好的。\n\n\n已经处理。");
    assert_eq!(
        strip_cron_commands("普通 [CRON_CREATE] 文本"),
        "普通 [CRON_CREATE] 文本"
    );
}
