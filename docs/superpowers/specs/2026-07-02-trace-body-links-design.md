# Trace Body Links Design

## Scope

Expanded trace bodies should recognize URL and local-path text as hidden links. Collapsed trace summary previews remain plain text so summary clicks only expand or collapse trace rows.

## Interaction

Trace links should look exactly like surrounding trace text by default: inherited color, no underline, and no visual link treatment. When the user holds Command on macOS or Control on Windows/Linux and hovers a trace body link, the link shows an underline without changing color and the cursor becomes a pointer. Clicking without the modifier does nothing; clicking with the modifier opens the target.

## Link Targets

The renderer should recognize bare `http://` and `https://` URLs, `file://` URLs, and absolute local paths. Local paths reuse the existing message-link path parsing behavior, including optional `:line` and `:line:column` suffixes.

## Architecture

`src/shared/trace-blocks.js` will tokenize only expanded trace body text and emit trace-only anchors using the existing message-link data attributes plus a trace marker. `src/renderer/app.js` will keep normal message-link behavior unchanged while requiring the modifier key for trace links. `src/renderer/styles/chat.css` will provide the hidden terminal-style hover treatment.

## Testing

Unit tests should verify that expanded trace bodies linkify URLs and local paths, collapsed summary previews stay plain text, and the trace link CSS preserves inherited color while only underlining during modifier-hover.
