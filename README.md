# BA-MemorialLobby-Assets

自動化建構 BA Memorial Lobby 的可發佈資源包。由 GitHub Actions 執行，產物發佈到 GitHub Releases。

## 產物

`assets_version.json` + 8 個 `assets-<name>-v<version>.tar.gz`：
`spine / voice / bgm / scene / data / intro / ui / students`

App (`BA-MemorialLobby-Player`) 啟動時會檢查 `releases/latest/download/assets_version.json` 並自動下載。

## 手動觸發建構

GitHub 網頁 → **Actions** → **Build & Release Assets** → **Run workflow**
- `version`: 例如 `2025.0819.0`
- `skip_download`: 首次保持 `false`

## 本地測試（只打包現有 assets）

```bash
WORK_DIR=/tmp/ba_build python3 scripts/build_assets.py --version 2025.0819.0 --only-package
ls -lh /tmp/ba_build/out/
```

## 依賴

- Python: `ba-downloader`, `UnityPy`, `Pillow`
- Node: `@esotericsoftware/spine-core`
- Rust: `baad` / `baax`（ Formal 建議用 `cargo install` 安裝 Deathemonic 工具鏈 ）
