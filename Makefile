# デフォルトターゲット: 依存インストール + SDK + VSCode エクステンションのフルビルド
# 成果物: apps/vscode/incline.vsix
all: full-build

# 依存パッケージのインストール
install:
	nice -n 19 bun install

# プロトコル定義の生成（必須、変更時のみ実行）
protos:
	cd apps/vscode && nice -n 19 bun run protos

# SDK のビルド
build-sdk:
	NODE_OPTIONS="--max-old-space-size=3072" nice -n 19 bun run build:sdk

# ローカルビルド（このマシン上で vsix を作る）
local: full-build

# VSCode エクステンションの差分ビルドとパッケージング
# SDKを再ビルドせず、apps/vscode 配下のみを対象に vsix を生成する
build-vscode:
	cd apps/vscode && \
	NODE_OPTIONS="--max-old-space-size=3072" nice -n 19 bunx @vscode/vsce package --no-dependencies --out incline.vsix

# SDKを含めたフルビルド
full-build: install protos build-sdk build-vscode

# キャッシュが壊れた時用のクリーンインストール
clean-install:
	nice -n 19 bun pm cache rm
	nice -n 19 bun install --force

.PHONY: all install local protos build-sdk build-vscode full-build clean-install

# 開発者ローカル専用の追加ターゲット (無ければ無視)
-include Makefile.aws
