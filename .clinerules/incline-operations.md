# INCLINE 運用ルール (エージェント向け)

**誰が何を使うか**: INCLINE の中で動くエージェント (Gemini など) は、タスク操作に組み込みの `task_tracker` ツールを使う
(`action=list|create|update|note`、INCLINE の中で動くので認証も接続先の設定も要らない。MCP も curl も使わない)。
以下の `task_note` / `task_list` などは、同じ操作を指す。INCLINE の外の AI (Claude など) は、同じ操作を MCP の
`task_*` ツール (`scripts/incline-mcp`) で行う。INCLINE のエージェントは MCP を使う側ではなく、操作される側である。

毎回の指示文に書いていた定型事項。このファイルは `.clinerules/` にあるので、INCLINE (Cline) のエージェントが
作業開始時に自動で読む。別のリポジトリで使うときはこのファイルを `.clinerules/` にコピーする。

## 報告と停止
- 作業の区切り・完了・質問は、`task_tracker` ツールの `action=note` でタスクの履歴に書く (補助として ntfy に投稿してもよい)。
- (INCLINE の外の AI 向け) 人間 / 他の AI への連絡は MCP の `post_message(to, title, text)` で投稿し、返事は `read_messages(to=自分の名前, unacked_by=自分の名前)` で読み、読んだら `ack_message` で既読にする。INCLINE のエージェントは、連絡もタスクの履歴 (`task_tracker` の `note`) に書く。ntfy の公開トピックには機密を書かない。
- 報告したら、それ以上は自分から作業を進めず**停止**して、指示を待つ。
- タスクを自分で「完了」「削除」にしない。完了報告 (何をしたか・どう確認したか・残り) を残して `報告` にする (人間の確認待ちの印。AI が付けるのはここまで)。
  完了にするのは人間。未検証のことは「未検証」と書く。
- ステータス `差戻` = 人間が報告を見て差し戻した印。最新の人間のメモ (理由) を読んでやり直し、着手で `対応中`、終えたら再び `報告` にする。

## 判断待ち ([CONFIRM] / [RESOLVED])
- 人間の判断が要るときは、`task_tracker` の `note` (MCP なら `task_note`) で履歴の本文を `[CONFIRM]` で始める (質問・選択肢・自分の既定の選択)。INCLINE Tasks でそのタスクと行が赤く点滅する。書いたら止まって待つ (推測で進めない)。
- 本文の途中の「[CONFIRM]」は発火しない。`[RESOLVED]` で始まる行が打ち消す。同時に複数あるときは `[CONFIRM:topic]` / `[RESOLVED:topic]`。
- 人間が『変更を保存』で [CONFIRM] の次の行を確定すると、`[INCLINE NOTICE]` で通知が来る。履歴を読み、答えになっていれば `[RESOLVED]` で決定事項を書く。答えになっていなければ待ち続ける (RESOLVED を付けない)。
- `task_list` の `⚠CONFIRM` は判断待ちのタスク。作業開始時に確認する。

## task.md
- `task.md` を直接編集しない。INCLINE のエージェントは `task_tracker` ツール、INCLINE の外の AI は MCP の `task_list` / `task_create` / `task_update` / `task_note` で操作する。
  (MCP の接続先は環境変数 `INCLINE_MCP_URL` / `INCLINE_MCP_TOKEN`。同じウィンドウならデバッグモードは不要。INCLINE のエージェントには要らない。)操作方法は `.clinerules/incline-mcp-usage.md`、CLI は `scripts/incline-mcp`。
- やむを得ず直接編集するときは `task.md.lock` の手順に従う (システムプロンプトの「Shared backlog」節を参照)。
  `data-tmp-::` の行は人間の未確定の下書きなので触らない。

## コマンド
- `pkill -f` を使わない (コマンド行の一部に一致して自分のシェルまで落とすことがある)。止めたいプロセスは PID を調べて `kill <pid>`。
- `make run` を使わない (終了しないのでターミナルを塞ぐ)。長く動くものはバックグラウンドで起動し、ログをファイルに出す。
- テストは 1 本ずつ実行する。全件を一度に流さず、対象のファイル / テスト名を指定する。

## トークン
- 入力トークンが 100k に達したら作業を止め、状況をタスクの履歴 (`note`) に報告して、続けてよいか確認を取る。

## 画面操作 (GUI のキー・マウス操作)
- 操作する前に、人間に許可を取る。
- 操作前の状態 (マウス位置・Caps Lock・IME) を記録し、終わったら必ず原状に戻す (押しっぱなしのキーの解除、マウスを元の位置へ、Caps Lock / IME が操作前と同じか確認)。
