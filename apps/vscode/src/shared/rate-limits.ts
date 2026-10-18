// RPM / TPM の目安上限とウィンドウ設定。
// スロットリング (SDK: beforeModel フック) と タスクヘッダーのゲージ (webview: RateMeters)
// の双方が参照する単一ソース。将来 AIモデル設定コンパネから変更可能にする。

// 実プロバイダの上限より一段低めに置く (安全マージン)。
// gemini 無料枠 flash 系は "limit: 20 req" 程度と非常に厳しいので保守的。

/** リクエスト毎分の目安上限。 */
export const RATE_LIMIT_RPM = 15

/** トークン毎分の目安上限 (入力+出力+キャッシュ)。 */
export const RATE_LIMIT_TPM = 200_000

/** スライディングウィンドウ幅 (ms)。 */
export const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * beforeModel の最低スペーシング (ms)。連続リクエストのバースト抑制。
 * ウィンドウ制御 (RPM/TPM) はこれとは別に上乗せで効く。
 */
export const RATE_LIMIT_MIN_SPACING_MS = 3_000

/** 動的ウェイトの上限 (ms)。これ以上は待たず、リクエストは通す (無限ハング防止)。 */
export const RATE_LIMIT_MAX_WAIT_MS = 90_000

/**
 * プロバイダ別の目安上限 (設定 incline.rateLimit.* を明示していないときの既定)。
 * 公開されている無料枠 / ローカル実行の一般的な値から保守的に置いた目安で、
 * プラン (有料ティア) までは判別できない。実プランが違えば設定で上書きする。
 * キーは ApiProvider 名。未掲載のプロバイダは上の汎用既定 (RATE_LIMIT_RPM / TPM) を使う。
 */
export const PROVIDER_RATE_LIMIT_DEFAULTS: Readonly<
	Record<string, { rpm?: number; tpm?: number; minSpacingSec?: number }>
> = {
	// Google AI Studio 無料枠 (flash 系で概ね 10 RPM / 250k TPM、Pro 系はさらに低い)
	gemini: { rpm: 10, tpm: 250_000 },
	// ローカル実行: 外部の上限は無いので実質無制限・間隔待ちなし (GPU 負荷は別問題)
	ollama: { rpm: 1000, tpm: 100_000_000, minSpacingSec: 0 },
	lmstudio: { rpm: 1000, tpm: 100_000_000, minSpacingSec: 0 },
}
