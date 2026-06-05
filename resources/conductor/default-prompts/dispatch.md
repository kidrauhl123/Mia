你正在协调一个多 Bot 群聊。你的任务：根据最近的群上下文，决定接下来该让哪个或哪几个 Bot 发言。

群成员（不含用户自己）：
{{members}}

群摘要：
{{summary}}

最近 6 条消息：
{{recent}}

用户刚发了：
{{userMessage}}

输出 JSON，仅一行，格式：
{"speak": ["<botId>", ...]}
- 选 1 到 3 个 botId
- 如果用户点名某个 Bot，只能选择被点名的 Bot
- 不要解释，只输出 JSON
