import { Modal, StyleSheet, View } from "react-native";
import type { AndroidUpdateManifest, IosUpdateManifest } from "./manifest";
import Button from "../ui/Button";
import { Body, BodyStrong, Sub } from "../ui/Text";
import { color, radius, shadow, space } from "../theme";

export type UpdatePromptPhase =
  | "ready"
  | "checking"
  | "downloading"
  | "verifying"
  | "waiting_permission"
  | "opening_installer"
  | "failed";

export type UpdatePromptModel =
  | {
      kind: "android-binary";
      target: AndroidUpdateManifest;
      mandatory: boolean;
      phase: UpdatePromptPhase;
      error?: string;
    }
  | {
      kind: "ios-store";
      target: IosUpdateManifest;
      mandatory: false;
      phase: UpdatePromptPhase;
      error?: string;
    }
  | {
      kind: "ota";
      mandatory: false;
      phase: UpdatePromptPhase;
      error?: string;
    };

interface Props {
  prompt: UpdatePromptModel | null;
  onPrimary: () => void;
  onDismiss: () => void;
}

function titleFor(prompt: UpdatePromptModel): string {
  if (prompt.kind === "ota") return "发现小更新";
  return "发现新版本";
}

function versionFor(prompt: UpdatePromptModel): string {
  if (prompt.kind === "android-binary") return `${prompt.target.versionName} (${prompt.target.versionCode})`;
  if (prompt.kind === "ios-store") return `${prompt.target.versionName} (${prompt.target.buildNumber})`;
  return "可立即应用";
}

function primaryLabelFor(prompt: UpdatePromptModel): string {
  if (prompt.phase === "waiting_permission") return "打开安装器";
  if (prompt.phase === "failed") return "重试";
  if (prompt.kind === "android-binary") return "下载更新";
  if (prompt.kind === "ios-store") return "打开 TestFlight";
  return "更新并重启";
}

function busyFor(prompt: UpdatePromptModel): boolean {
  return prompt.phase === "checking" || prompt.phase === "downloading" || prompt.phase === "verifying" || prompt.phase === "opening_installer";
}

function statusFor(prompt: UpdatePromptModel): string {
  if (prompt.error) return prompt.error;
  if (prompt.phase === "downloading") return "正在下载安装包...";
  if (prompt.phase === "verifying") return "正在校验安装包...";
  if (prompt.phase === "waiting_permission") return "需要允许 Mia 安装未知来源应用";
  if (prompt.phase === "opening_installer") return "正在打开系统安装器...";
  return "";
}

export default function UpdatePrompt({ prompt, onPrimary, onDismiss }: Props) {
  if (!prompt) return null;
  const status = statusFor(prompt);
  const notes = prompt.kind === "android-binary" ? prompt.target.notes : [];
  return (
    <Modal transparent visible animationType="fade" onRequestClose={prompt.mandatory ? undefined : onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <View style={styles.head}>
            <BodyStrong style={styles.title}>{titleFor(prompt)}</BodyStrong>
            <Sub>{versionFor(prompt)}</Sub>
          </View>
          {notes.length ? (
            <View style={styles.notes}>
              {notes.slice(0, 4).map((note) => (
                <Body key={note} style={styles.note}>
                  {note}
                </Body>
              ))}
            </View>
          ) : null}
          {status ? <Sub style={[styles.status, prompt.error ? styles.error : null]}>{status}</Sub> : null}
          <View style={styles.actions}>
            <Button label={primaryLabelFor(prompt)} busy={busyFor(prompt)} onPress={onPrimary} />
            {!prompt.mandatory ? <Button label="稍后" variant="ghost" onPress={onDismiss} /> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
    backgroundColor: "rgba(0,0,0,0.22)",
  },
  panel: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    ...shadow,
  },
  head: { gap: space.xs },
  title: { fontSize: 18 },
  notes: { gap: space.xs },
  note: { color: color.inkMuted },
  status: { color: color.inkMuted },
  error: { color: color.danger },
  actions: { gap: space.sm },
});
