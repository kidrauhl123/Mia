import {
  memo,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { bridge } from "../bridge";

function ComposerInputComponent() {
  return (
    <div
      id="chatInput"
      className="composer-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-placeholder="输入消息，Enter 发送，Shift+Enter 换行"
      onBlur={(event: ReactFocusEvent<HTMLDivElement>) => {
        bridge.invoke("composerBlur", event.nativeEvent);
      }}
      onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        bridge.invoke("composerClick", event.nativeEvent);
      }}
      onCompositionEnd={(event: ReactCompositionEvent<HTMLDivElement>) => {
        bridge.invoke("composerCompositionEnd", event.nativeEvent);
      }}
      onCompositionStart={(event: ReactCompositionEvent<HTMLDivElement>) => {
        bridge.invoke("composerCompositionStart", event.nativeEvent);
      }}
      onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
        bridge.invoke("composerContextMenu", event.nativeEvent);
      }}
      onInput={(event: FormEvent<HTMLDivElement>) => {
        bridge.invoke("composerInput", event.nativeEvent as InputEvent);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        bridge.invoke("composerKeyDown", event.nativeEvent);
      }}
      onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
        bridge.invoke("composerPaste", event.nativeEvent);
      }}
    />
  );
}

export const ComposerInput = memo(ComposerInputComponent);
