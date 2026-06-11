import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { Bot } from "../api/types";
import { useCreateCloudBot, useModelCatalog } from "../state/queries";
import { botKey, cloudBotKeyFromName } from "../logic/botDraft";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { Sub, Title } from "../ui/Text";
import { color, radius, space } from "../theme";

export default function CreateBotPanel({ bots }: { bots: Bot[] }) {
  const [name, setName] = useState("");
  const [personaText, setPersonaText] = useState("");
  const [status, setStatus] = useState("");
  const models = useModelCatalog();
  const createBot = useCreateCloudBot();
  const trimmedName = name.trim();

  async function create() {
    if (!trimmedName) {
      setStatus("请输入智能体名称");
      return;
    }
    setStatus("");
    const botId = cloudBotKeyFromName(trimmedName, bots.map(botKey));
    const defaultModel = models.data?.[0]?.value || models.data?.[0]?.id || "mia-default";
    try {
      await createBot.mutateAsync({ botId, draft: { name: trimmedName, personaText }, defaultModel });
      setName("");
      setPersonaText("");
      setStatus("智能体已创建");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "创建失败");
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Title>新建智能体</Title>
        <Sub>云端 Hermes · 默认会话</Sub>
      </View>
      <Input value={name} onChangeText={setName} placeholder="名称" returnKeyType="next" />
      <Input
        value={personaText}
        onChangeText={setPersonaText}
        placeholder="人设"
        multiline
        textAlignVertical="top"
        style={styles.persona}
      />
      <Button label="创建智能体" onPress={create} busy={createBot.isPending} disabled={!trimmedName} />
      {status ? <Sub style={styles.status}>{status}</Sub> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.md,
  },
  head: { gap: 2 },
  persona: { minHeight: 82 },
  status: { color: color.inkMuted },
});
