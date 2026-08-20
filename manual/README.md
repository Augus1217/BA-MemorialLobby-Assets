# manual/ — 手動維護的素材（進 repo 的來源）

這些是無法自動生成的素材，`copy_assets.py` 會把它們拷貝到最終 `assets/`。

## ui/（氣泡、游標）

| 檔案 | 用途 |
|------|------|
| `Lobby_balloon.png` | Talk 對話氣泡（136x146，NGUI 9-slice borders L80 R50 T84 B60） |
| `Lobby_balloon2.png` | Think 對話氣泡（186x146，borders L130 R50 T85 B55） |
| `PCIcon_MousePoint.png` | 游標圖 |

## students/（學生頭像）

- `icon_index.json`：頭像索引（id -> 檔名對應）
- `<id>.png`：各學生頭像縮圖

## intro/（開場影片）

- 由 `scripts/extract_intro.py` 從 APK 自動解包 + 轉碼，**不需手動放**。
- 若自動失敗，也可手動放 `title_h264.mp4` + `pv-a.ogg`。

> 把檔案放進對應子目錄即可，`build_assets.py` 會自動帶入對應 package。
