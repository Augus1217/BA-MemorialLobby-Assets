# data/ — 手動維護的 Metadata 來源

這個目錄是 `build_assets.py` 打包 `assets/data` 的**單一來源**（`copy_assets.py` 會把這裡的所有 `.json`/`.csv` 全量拷貝）。

以下檔案無法從遊戲 ExcelDB 自動生成，需要從開發機（原本在 `/home/augus/BA_MemorialLobby/data`）搬來放進這裡：

| 檔案 | 用途 | 來源 |
|------|------|------|
| `flash_curves.json` | 每角色開場白色閃憶曲線（exposure/sprite/dof 三次曲線） | Unity `PPPV_Lobby_*` prefab 手動提取 |
| `lobby_chat_anchors.json` | 對話氣泡錨點位置（tx/ty/skY/skScale） | Unity `LobbyCH*.prefab` 手動提取 |
| `lobby_camera_config.json` | 鏡頭縮放設定（MaxScale/Weight） | 手動維護 |
| `lobby_voice_schedule.json` | 語音播放排程 | 手動維護 |
| `lobby_bgm_mapping.csv` | BGM 對照 | `extract_bgm_mapping.py` 自動（也可手動） |
| `voice_index.json` | 語音索引 | `extract_voice_index.py` 自動（也可手動） |
| `students_data.csv` | 學生後設資料 | `extract_students.py` 自動下載 |
| `lobby_subtitle.json` | 逐字稿 | `extract_subtitles.py` 自動 |
| `lobby_dialog_types.json` | 對話類型 | `extract_dialog_types.py` 自動 |
| `icon_index.json` | 學生頭像索引（對應 `assets/students/`） | 手動維護 |
| `characters_index.csv` | 角色索引 | 手動維護 |

> 備註：自動生成的檔案（bgm_mapping、voice_index、students_data、subtitle、dialog_types）
> 會在 build 時覆寫這裡的版本；手動檔則直接採用。
> 缺檔只會讓 Player 降級（用內建模板 / 預設位置），不會讓打包失敗。
