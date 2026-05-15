# Animation Rows

The Codex app reads one fixed atlas: 8 columns, 9 rows, 192x208 pixels per cell.

| Row | State | Used columns | Durations |
| --- | --- | ---: | --- |
| 0 | idle | 0-5 | 280, 110, 110, 140, 140, 320 ms |
| 1 | unused | none | Reserved for Codex atlas compatibility; left transparent |
| 2 | unused | none | Reserved for Codex atlas compatibility; left transparent |
| 3 | waving | 0-3 | 140 ms each, final 280 ms |
| 4 | jumping | 0-4 | 140 ms each, final 280 ms |
| 5 | failed | 0-7 | 140 ms each, final 240 ms |
| 6 | waiting | 0-5 | 150 ms each, final 260 ms |
| 7 | unused | none | Reserved for Codex atlas compatibility; left transparent |
| 8 | review | 0-5 | 150 ms each, final 280 ms |

Unused cells after each row's final used column must be fully transparent.

## Row Purposes

- `idle`: calm, low-distraction breathing/blinking loop; use as the reduced-motion first frame. Keep motion subtle and persona-preserving.
- `waving`: greeting or attention gesture; clear start, raised gesture, return.
- `jumping`: anticipation, lift, peak, descent, settle.
- `failed`: error/sad/deflated reaction; readable but not visually noisy.
- `waiting`: patient idle variant; glance, small bounce, or prop motion.
- `review`: focused/inspecting/thinking loop suitable for review state.
