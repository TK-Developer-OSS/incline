import {
	RATE_LIMIT_MAX_WAIT_MS,
	PROVIDER_RATE_LIMIT_DEFAULTS,
	RATE_LIMIT_MIN_SPACING_MS,
	RATE_LIMIT_RPM,
	RATE_LIMIT_SOFT_RATIO,
	RATE_LIMIT_TPM,
	RATE_LIMIT_WINDOW_MS,
} from "@/shared/rate-limits"
import { Logger } from "@/shared/services/Logger"
import { logActivity } from "./activity-log"

function stamp1(ms: number): string {
	return inclineTimestamp(new Date(ms))
}

function inclineTimestamp(date: Date = new Date()): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0")
	return (
		`${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
		`${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`
	)
}

// 簡易的な強制ウェイト方式のレートリミッター。
// RPM (Requests Per Minute) / TPM (Tokens Per Minute) 回避のため、
// 指定した時間だけ無条件に待機する。
//
// スロットリングポイントごとに独立したインスタンスを持ち、待機時間を
// 個別に調整できる。暫定はコード内固定 (10秒)。最終的には AIモデル設定
// コンパネから updateMinDelay() で動的に変更する想定。

// vitest / mocha / e2e 実行時は強制ウェイトを無効化する (テストが10秒×回数
// ぶん遅くなるのを防ぐ)。VITEST は Vitest が自動設定、IS_TEST/E2E_TEST は
// このリポジトリの既存テスト規約 (otel-config.ts / posthog-config.ts 参照)。
const IS_TEST_ENV =
	process.env.VITEST === "true" ||
	process.env.NODE_ENV === "test" ||
	process.env.IS_TEST === "true" ||
	process.env.E2E_TEST === "true"

export class ApiRateLimiter {
	private lastRequestTime: number = 0;
	private minDelayMs: number;

	constructor(minDelayMs: number = 10000) {
		this.minDelayMs = minDelayMs;
	}

	// 将来的にAI設定画面から動的に変更できるようにする
	public updateMinDelay(newMinDelayMs: number): void {
		this.minDelayMs = newMinDelayMs;
	}

	public getMinDelay(): number {
		return this.minDelayMs;
	}

	private getTimestamp(): string {
		const now = new Date();
		return (
			now.getFullYear() +
			"-" +
			String(now.getMonth() + 1).padStart(2, "0") +
			"-" +
			String(now.getDate()).padStart(2, "0") +
			" " +
			String(now.getHours()).padStart(2, "0") +
			":" +
			String(now.getMinutes()).padStart(2, "0") +
			":" +
			String(now.getSeconds()).padStart(2, "0") +
			"." +
			String(now.getMilliseconds()).padStart(3, "0")
		);
	}

	public async wait(callerName: string = "unknown"): Promise<void> {
		const delayRequired = this.minDelayMs; // 常に設定時間分待機

		// 待機不要のケース (テスト環境 / 遅延0以下で無効化) は即リターン
		if (IS_TEST_ENV || delayRequired <= 0) {
			return;
		}

		// 強制的に指定時間待機させる（呼び出し元関数名を含む）
		const logMsg = `[INCLINE] [${this.getTimestamp()}] RateLimiter active [${callerName}]: FORCED WAIT ${delayRequired}ms`;
		Logger.log(logMsg);
		process.stderr.write(logMsg + "\n");
		logActivity("WAIT", `fixed ${delayRequired}ms before ${callerName}`);

		await new Promise((resolve) => setTimeout(resolve, delayRequired));

		this.lastRequestTime = Date.now();
	}
}

// --- スロットリングポイント別インスタンス ---------------------------------
// 待機時間 (ms)。暫定コード内固定。最終的には AIモデル設定コンパネから制御する。
export const RATE_LIMIT_DEFAULT_DELAY_MS = 10000

/**
 * 各モデル(LLM)リクエスト前 (AgentRuntime.beforeModel フック) と、ファイル
 * ベースのフックイベント dispatch 前 (VscodeSessionHost.handleHookEvent) に
 * 効かせる共有インスタンス。「1ターン1回」ではなくエージェントループの
 * 反復ごと (= モデルリクエストごと) に待機する。
 */
export const modelRequestRateLimiter = new ApiRateLimiter(RATE_LIMIT_DEFAULT_DELAY_MS)

/**
 * [A] 各ツール実行前 (AgentRuntime.beforeTool フック) に効かせるインスタンス。
 * 人間目線の「アクション」単位 (ファイル読み・コマンド実行など) の強制ウェイト。
 * modelRequestRateLimiter とは独立に待機時間を設定できる。
 *
 * [B] エージェントライフサイクルイベントごとの強制ウェイト (onEvent フックを
 * turn-started / assistant-message / tool-started / tool-finished / turn-finished
 * に絞って適用) は未実装。incline.md の残タスク参照。実装時はここに
 * lifecycleEventRateLimiter を追加し、A とは別パラメータで制御する。
 */
export const toolExecutionRateLimiter = new ApiRateLimiter(RATE_LIMIT_DEFAULT_DELAY_MS)

/**
 * 各モデルリクエストの前に必ず入れる固定ウェイト (リクエスト 1 回あたり)。最低間隔 (minSpacing、前回から足りない分だけ待つ) と違い、
 * 常に指定秒だけ待つ。既定 5 秒。0 で無効。
 */
export const RATE_LIMIT_DEFAULT_ACTION_DELAY_MS = 5000
export const requestDelayRateLimiter = new ApiRateLimiter(RATE_LIMIT_DEFAULT_ACTION_DELAY_MS)

/**
 * 各ツール (アクション) の実行後に入れる固定ウェイト。結果をモデルに返す前に待つので、次のモデルリクエストまでの間隔が空く。
 * 既定 5 秒。0 で無効。実行前のウェイトは toolExecutionRateLimiter。
 */
export const toolAfterRateLimiter = new ApiRateLimiter(RATE_LIMIT_DEFAULT_ACTION_DELAY_MS)

// --- 動的 RPM/TPM スロットリング (beforeModel 用) ------------------------
// 固定ウェイトではなく、直近60秒のリクエスト数 / トークン数が目安上限に
// 近づいたときだけ必要なぶん待つスライディングウィンドウ方式。
//  - リクエスト時刻は acquire() で記録 (RPM)
//  - トークン数は recordUsage() で記録 (TPM) — usage イベントから per-turn 値を渡す
//    (sdk-session-event-coordinator.ts が投入する)

export interface UsageSnapshot {
	rpm: number
	tpm: number
	rpd: number
	/** この値を作った時刻 (ホストの epoch ms)。 */
	at: number
	/** 直近60秒のリクエスト時刻。 */
	reqs: number[]
	/** 直近60秒のトークン使用量。 */
	tokens: { at: number; tokens: number }[]
}

interface TokenSample {
	at: number
	tokens: number
}

export class SlidingWindowModelRateLimiter {
	private reqTimes: number[] = []
	private tokenSamples: TokenSample[] = []
	/** 直近のリクエストの総トークン (次の入力の目安) と、まだ実績に載っていないツール結果の見積もり (#121)。 */
	private lastRequestTokens = 0
	private pendingTokens = 0

	// 表示用の使用量 (セッション単位)。スロットリング用の reqTimes / tokenSamples とは別に
	// 持ち、セッションを切り替えたら表示だけリセットする (実際の待機制御には影響しない)。
	private viewSessionId: string | undefined
	private viewReqs: number[] = []
	private viewTokens: TokenSample[] = []
	private rpd: number | undefined
	/** 429 を受けた後の冷却期限 (epoch ms)。この時刻まで次のモデルリクエストは送らない。 */
	private cooldownUntil = 0

	private rpm = RATE_LIMIT_RPM
	private tpm = RATE_LIMIT_TPM
	private minSpacingMs = RATE_LIMIT_MIN_SPACING_MS
	private softRatio = RATE_LIMIT_SOFT_RATIO
	private readonly windowMs = RATE_LIMIT_WINDOW_MS
	private readonly maxWaitMs = RATE_LIMIT_MAX_WAIT_MS

	/** 将来 AIモデル設定コンパネから上限を差し替える用。 */
	public updateLimits(opts: { rpm?: number; tpm?: number; minSpacingMs?: number; rpd?: number | null; softRatio?: number }): void {
		if (typeof opts.softRatio === "number" && opts.softRatio > 0 && opts.softRatio <= 1) {
			this.softRatio = opts.softRatio
		}
		if (opts.rpd === null) {
			this.rpd = undefined
		} else if (typeof opts.rpd === "number" && opts.rpd > 0) {
			this.rpd = opts.rpd
		}
		if (typeof opts.rpm === "number" && opts.rpm > 0) {
			this.rpm = opts.rpm
		}
		if (typeof opts.tpm === "number" && opts.tpm > 0) {
			this.tpm = opts.tpm
		}
		if (typeof opts.minSpacingMs === "number" && opts.minSpacingMs >= 0) {
			this.minSpacingMs = opts.minSpacingMs
		}
	}

	public getMinSpacingMs(): number {
		return this.minSpacingMs
	}

	/** 現在の RPM / TPM 上限 (ゲージ表示用)。 */
	public getLimits(): { rpm: number; tpm: number; rpd?: number } {
		return { rpm: this.rpm, tpm: this.tpm, ...(this.rpd ? { rpd: this.rpd } : {}) }
	}

	/**
	 * 表示用メーターの対象セッションを切り替える。変わったら表示用の集計をリセットする
	 * (スロットリングの状態は保持)。
	 */
	public setViewSession(sessionId: string | undefined): void {
		if (sessionId === this.viewSessionId) {
			return
		}
		this.viewSessionId = sessionId
		this.viewReqs = []
		this.viewTokens = []
	}

	/**
	 * 表示用の使用量 + 直近60秒のサンプル (リクエスト時刻 / トークン)。webview はサンプルから
	 * 毎秒メーターを計算し直し、60秒の窓から古い分が抜けていく動きを滑らかに見せる (#77)。
	 */
	public usageSnapshot(now: number = Date.now()): UsageSnapshot {
		const base = this.usageView(now)
		const minCutoff = now - this.windowMs
		return {
			...base,
			at: now,
			reqs: this.viewReqs.filter((t) => t >= minCutoff),
			tokens: this.viewTokens.filter((s) => s.at >= minCutoff).map((s) => ({ at: s.at, tokens: s.tokens })),
		}
	}

	/** 表示用の使用量: 直近60秒の RPM / TPM と、直近24時間の RPD (現在のセッション分)。 */
	public usageView(now: number = Date.now()): { rpm: number; tpm: number; rpd: number } {
		const dayCutoff = now - 24 * 60 * 60 * 1000
		while (this.viewReqs.length > 0 && this.viewReqs[0] < dayCutoff) {
			this.viewReqs.shift()
		}
		const minCutoff = now - this.windowMs
		while (this.viewTokens.length > 0 && this.viewTokens[0].at < minCutoff) {
			this.viewTokens.shift()
		}
		const rpm = this.viewReqs.filter((t) => t >= minCutoff).length
		const tpm = this.viewTokens.reduce((sum, s) => sum + s.tokens, 0)
		return { rpm, tpm, rpd: this.viewReqs.length }
	}

	/** モデルレスポンスの per-turn トークン使用量を記録する (TPM 計算用)。 */
	public recordUsage(tokens: number, at: number = Date.now()): void {
		if (Number.isFinite(tokens) && tokens > 0) {
			recordRateLimitSuccess()
			this.tokenSamples.push({ at, tokens })
			this.viewTokens.push({ at, tokens })
			// 実績が届いたので、それまでの見積もり (予約) は実績に置き換わった。直近のリクエストの大きさは、次の入力の目安になる。
			this.lastRequestTokens = tokens
			this.pendingTokens = 0
		}
	}

	/**
	 * アクション (ツール実行) の結果のトークン量の見積もりを『予約』する (#121)。ツール結果のトークンは、次のモデルリクエストの
	 * 入力になって初めて usage に載る (実績の記録はそのリクエストの後) ので、記録を待つと、大きな結果を送った直後に枠を超える。
	 * 予約した分は、次の computeWaitMs の予測に含まれ、次の実績 (recordUsage) が届くと消える。
	 */
	public reservePending(tokens: number): void {
		if (Number.isFinite(tokens) && tokens > 0) {
			this.pendingTokens = Math.min(this.pendingTokens + Math.ceil(tokens), 10_000_000)
		}
	}

	/** 次のモデルリクエストが TPM に足す量の予測: 直近のリクエストの大きさ (文脈はほぼ引き継がれる) + 予約したツール結果。 */
	private predictNextRequestTokens(): number {
		return Math.min(this.lastRequestTokens + this.pendingTokens, this.tpm)
	}

	public cooldownRemainingMs(now: number = Date.now()): number {
		return Math.max(0, this.cooldownUntil - now)
	}

	/** プロバイダにレート制限された後、指定時間は次のモデルリクエストを止める。 */
	public coolDown(ms: number, now: number = Date.now()): void {
		if (Number.isFinite(ms) && ms > 0) {
			this.cooldownUntil = Math.max(this.cooldownUntil, now + ms)
		}
	}

	/** 手動でリクエスト時刻を記録 (テスト用)。 */
	public noteRequest(at: number = Date.now()): void {
		this.reqTimes.push(at)
		this.viewReqs.push(at)
	}

	private prune(now: number): void {
		const cutoff = now - this.windowMs
		while (this.reqTimes.length > 0 && this.reqTimes[0] < cutoff) {
			this.reqTimes.shift()
		}
		while (this.tokenSamples.length > 0 && this.tokenSamples[0].at < cutoff) {
			this.tokenSamples.shift()
		}
	}

	private tokenSum(): number {
		let sum = 0
		for (const s of this.tokenSamples) {
			sum += s.tokens
		}
		return sum
	}

	/** 直近ウィンドウの使用状況 (デバッグ / 表示用)。副作用として prune する。 */
	public snapshot(now: number = Date.now()): { rpmUsed: number; tpmUsed: number; rpmLimit: number; tpmLimit: number } {
		this.prune(now)
		return { rpmUsed: this.reqTimes.length, tpmUsed: this.tokenSum(), rpmLimit: this.rpm, tpmLimit: this.tpm }
	}

	/**
	 * 次のモデルリクエストまでに必要な待機時間 (ms) と理由。副作用として prune する
	 * が reqTimes には積まない (acquire() が積む)。
	 */
	public computeWaitMs(now: number = Date.now(), forTool = false): { waitMs: number; reasons: string[] } {
		this.prune(now)
		let waitMs = 0
		const reasons: string[] = []
		// 実際に守るのは目安上限の 60% (RATE_LIMIT_SOFT_RATIO)。
		const rpmCap = Math.max(1, Math.floor(this.rpm * this.softRatio))
		const tpmCap = Math.max(1, Math.floor(this.tpm * this.softRatio))

		// RPM: ウィンドウ内リクエスト数が上限以上なら、枠が空くまで待つ
		if (this.reqTimes.length >= rpmCap) {
			const idx = Math.max(0, this.reqTimes.length - rpmCap)
			const freeAt = this.reqTimes[idx] + this.windowMs
			waitMs = Math.max(waitMs, freeAt - now)
			reasons.push(`RPM ${this.reqTimes.length}/${rpmCap} (${Math.round(this.softRatio * 100)}% of ${this.rpm})`)
		}

		// TPM: ウィンドウ内トークン数 + 次のリクエストの予測 (直近のリクエストの大きさ + 予約したツール結果) が上限を超えるなら、
		// 古いサンプルが十分抜けるまで待つ。予測を足さないと『今は上限未満』で送って、そのリクエスト自体が枠を超える (#121)。
		const sum = this.tokenSum()
		const next = this.predictNextRequestTokens()
		if (sum + next >= tpmCap && sum > 0 && this.tokenSamples.length > 0) {
			let running = sum
			let freeAt = now
			for (const s of this.tokenSamples) {
				running -= s.tokens
				if (running + next < tpmCap) {
					freeAt = s.at + this.windowMs
					break
				}
				freeAt = s.at + this.windowMs
			}
			waitMs = Math.max(waitMs, freeAt - now)
			reasons.push(next > 0 && sum < tpmCap ? `TPM ${sum}+next ${next}/${tpmCap} (${Math.round(this.softRatio * 100)}% of ${this.tpm})` : `TPM ${sum}/${tpmCap} (${Math.round(this.softRatio * 100)}% of ${this.tpm})`)
		}

		// 最低スペーシング
		if (!forTool && this.minSpacingMs > 0 && this.reqTimes.length > 0) {
			const sinceLast = now - this.reqTimes[this.reqTimes.length - 1]
			const w = this.minSpacingMs - sinceLast
			if (w > waitMs) {
				waitMs = w
				if (reasons.length === 0) {
					reasons.push("min-spacing")
				}
			}
		}

		waitMs = Math.min(Math.max(0, Math.ceil(waitMs)), this.maxWaitMs)

		// 冷却中: 上限 (maxWaitMs) には縛られず、期限まで待つ。
		if (this.cooldownUntil > now) {
			waitMs = Math.max(waitMs, this.cooldownUntil - now)
			reasons.push("cooldown after 429")
		}
		return { waitMs, reasons }
	}

	/**
	 * ツール実行の直前に呼ぶ。RPM / TPM が上限の 60% に達しているあいだは、ツールも動かさず待つ (リクエスト時刻は記録しない)。
	 * ツール自体は枠を使わないが、結果が次のモデルリクエストになるので、枠が厳しいときはここで歩調を落とす。
	 */
	public async waitForToolHeadroom(callerName: string = "unknown"): Promise<void> {
		const { waitMs, reasons } = this.computeWaitMs(Date.now(), true)
		if (waitMs > 0 && !IS_TEST_ENV) {
			const msg = `[INCLINE] [${inclineTimestamp()}] RateLimiter tool [${callerName}]: WAIT ${waitMs}ms (${reasons.join(", ")})`
			Logger.log(msg)
			logActivity("WAIT", `${waitMs}ms before ${callerName} (${reasons.join(", ")})`)
			await new Promise((resolve) => setTimeout(resolve, waitMs))
		}
	}

	/** モデルリクエスト直前に呼ぶ。必要なら待ち、リクエスト時刻を記録する。 */
	public async acquire(callerName: string = "unknown"): Promise<void> {
		const { waitMs, reasons } = this.computeWaitMs()

		if (waitMs > 0 && !IS_TEST_ENV) {
			const msg = `[INCLINE] [${inclineTimestamp()}] RateLimiter dynamic [${callerName}]: WAIT ${waitMs}ms (${reasons.join(", ") || "spacing"})`
			Logger.log(msg)
			process.stderr.write(`${msg}\n`)
			logActivity("WAIT", `${waitMs}ms before ${callerName} (${reasons.join(", ") || "spacing"})`)
			await new Promise((resolve) => setTimeout(resolve, waitMs))
		}
		logActivity("API", `model request start (${callerName}) rpm=${this.snapshot().rpmUsed + 1}/${this.rpm} tpm=${this.tokenSum()}/${this.tpm}`)
		this.noteRequest()
	}
}

/** 文字列のトークン数の概算: ASCII は 4 文字 ≈ 1 トークン、それ以外 (日本語など) は 1 文字 ≈ 1 トークン (多めに見る)。 */
export function estimateTokensFromText(text: string): number {
	let ascii = 0
	let other = 0
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 128) {
			ascii++
		} else {
			other++
		}
	}
	return Math.ceil(ascii / 4) + other
}

/** 各モデルリクエスト前 (beforeModel フック) の動的 RPM/TPM スロットリング。 */
export const dynamicModelRateLimiter = new SlidingWindowModelRateLimiter()

// --- レート制限 / クォータ超過エラー時の自動リトライ ---------------------
// プロバイダから 429 / RESOURCE_EXHAUSTED / "exceeded your current quota" や、
// 一時的な高負荷 ("experiencing high demand" / "overloaded" / "try again later" /
// 5xx) が返ってターンが失敗したとき、一定時間待ってから自動でターンを再開する。
// 暫定は 60 秒からの倍々・最大2回。最終的には AIモデル設定コンパネから制御する。

/** リトライまでの待機時間 (ms)。既定60秒。 */
export const RATE_LIMIT_RETRY_DELAY_MS = 60_000
/** 自動リトライの待機時間の上限 (ms)。倍々で伸ばしてここで頭打ち。 */
export const RATE_LIMIT_RETRY_MAX_DELAY_MS = 20 * 60_000
/**
 * 自動リトライの最大回数 (進捗なしの連続失敗)。超えたらエラーをそのまま UI に出す。
 * 2 回 (60 秒、120 秒と待つ)。多いと、枠切れのキーを叩き続けて長期ペナルティになる。途中で1イテレーションでも前進すればカウントは 0 に戻る。
 */
export const RATE_LIMIT_MAX_RETRIES = 2
// --- ユーザー設定 (incline.rateLimit.*) による上書き -----------------------
// 既定値は上の定数。applyRateLimitSettings() で実行中に差し替えられる。
let retryDelayMs = RATE_LIMIT_RETRY_DELAY_MS
let maxRetries = RATE_LIMIT_MAX_RETRIES

/** 現在の自動リトライ最大回数。 */
export function getRateLimitMaxRetries(): number {
	return maxRetries
}

/** 現在の自動リトライ待機時間 (ms)。 */
export function getRateLimitRetryDelayMs(): number {
	return retryDelayMs
}

export interface RateLimitSettings {
	rpm?: number
	tpm?: number
	/** 1日あたりのリクエスト数の目安上限 (メーター表示用。未設定なら上限なし)。 */
	rpd?: number
	minSpacingSec?: number
	retryDelaySec?: number
	maxRetries?: number
	toolDelaySec?: number
	/** 各モデルリクエストの前の固定ウェイト (秒)。 */
	requestDelaySec?: number
	/** 各ツール実行後の固定ウェイト (秒)。 */
	toolAfterDelaySec?: number
}

// 明示設定 (incline.rateLimit.*) > プロバイダ別既定 > 汎用既定 の順で有効値を決める。
let userSettings: RateLimitSettings = {}
let activeProviderId: string | undefined

const pos = (n: number | undefined): number | undefined =>
	typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined
const nonNeg = (n: number | undefined): number | undefined =>
	typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined

function recomputeLimits(): void {
	const prov = (activeProviderId && PROVIDER_RATE_LIMIT_DEFAULTS[activeProviderId]) || {}
	dynamicModelRateLimiter.updateLimits({
		rpm: pos(userSettings.rpm) ?? pos(prov.rpm) ?? RATE_LIMIT_RPM,
		tpm: pos(userSettings.tpm) ?? pos(prov.tpm) ?? RATE_LIMIT_TPM,
		minSpacingMs: (nonNeg(userSettings.minSpacingSec) ?? nonNeg(prov.minSpacingSec) ?? RATE_LIMIT_MIN_SPACING_MS / 1000) * 1000,
		rpd: pos(userSettings.rpd) ?? null,
	})
}

/**
 * ユーザー設定を反映する。明示していない項目 (undefined / 不正値) はプロバイダ別既定、
 * それも無ければ汎用既定になる (設定を消したら既定に戻る)。
 */
export function applyRateLimitSettings(s: RateLimitSettings): void {
	userSettings = { ...s }
	recomputeLimits()
	retryDelayMs = (nonNeg(s.retryDelaySec) ?? RATE_LIMIT_RETRY_DELAY_MS / 1000) * 1000
	maxRetries = Math.floor(nonNeg(s.maxRetries) ?? RATE_LIMIT_MAX_RETRIES)
	toolExecutionRateLimiter.updateMinDelay((nonNeg(s.toolDelaySec) ?? RATE_LIMIT_DEFAULT_DELAY_MS / 1000) * 1000)
	requestDelayRateLimiter.updateMinDelay((nonNeg(s.requestDelaySec) ?? RATE_LIMIT_DEFAULT_ACTION_DELAY_MS / 1000) * 1000)
	toolAfterRateLimiter.updateMinDelay((nonNeg(s.toolAfterDelaySec) ?? RATE_LIMIT_DEFAULT_ACTION_DELAY_MS / 1000) * 1000)
}

/**
 * 使用中のプロバイダを伝えて、RPM/TPM/最低間隔の既定をそのプロバイダの目安に切り替える。
 * モデルリクエスト前に毎回呼んでよい (変わっていなければ何もしない)。
 */
export function setActiveRateLimitProvider(providerId: string | undefined): void {
	if (providerId === activeProviderId) {
		return
	}
	activeProviderId = providerId
	recomputeLimits()
}

/**
 * 再開プロンプト。元のユーザーメッセージはセッション履歴に残っているので
 * 再送しない (SDK の Retry ボタンと同じ挙動: TASK_RESUMPTION_PROMPT)。
 */
export const RATE_LIMIT_RETRY_PROMPT = "[TASK RESUMPTION] Please continue where you left off."

// レート制限 / クォータ超過に加え、一時的なプロバイダ側エラー (高負荷・過負荷・
// 一時的に利用不可・5xx) も「待って再試行すれば直る」類として自動リトライ対象にする。
const RETRYABLE_PROVIDER_ERROR_PATTERN =
	/resource_exhausted|exceeded your current quota|quota exceeded|rate.?limit|too many requests|\b429\b|please retry in|experiencing high demand|high demand|overloaded|try again later|temporarily unavailable|currently unavailable|service (is )?unavailable|deadline.?exceeded|\b50[234]\b/i

/**
 * ターン結果テキスト等が「待てば直る」類のプロバイダエラー
 * (レート制限 / クォータ超過 / 高負荷 / 一時的な 5xx) を示すか。
 * 名前は歴史的経緯で `isRateLimitErrorText` のまま。
 */
export function isRateLimitErrorText(text: string | undefined | null): boolean {
	return typeof text === "string" && RETRYABLE_PROVIDER_ERROR_PATTERN.test(text) && !isDailyQuotaErrorText(text)
}

// Incline: サーバー側の一時的な失敗 (502 / 503 / 504・過負荷・高負荷・タイムアウト)。枠切れ (429) と違い、こちらの送信量が原因ではなく、
// 待てば直る。回数に上限を設けず再試行を続ける (待ち時間は倍々で伸ばし、上限は SERVER_ERROR_MAX_DELAY_MS)。429 / 枠切れの文面を含むものは除く。
const SERVER_ERROR_PATTERN =
	/experiencing high demand|high demand|overloaded|try again later|temporarily unavailable|currently unavailable|service (is )?unavailable|deadline.?exceeded|\b50[234]\b/i
const SERVER_ERROR_MAX_DELAY_MS = 5 * 60_000

export function isServerErrorText(text: string | undefined | null): boolean {
	return typeof text === "string" && SERVER_ERROR_PATTERN.test(text) && !QUOTA_CONTEXT_PATTERN.test(text) && !isDailyQuotaErrorText(text)
}

/** このエラーに対する自動リトライの上限。429 / 枠切れは設定値 (既定 2)、503 / 504 などは無制限。 */
export function rateLimitMaxRetriesFor(text: string | undefined | null): number {
	return isServerErrorText(text) ? Number.POSITIVE_INFINITY : maxRetries
}

/** 画面 / ログ用の上限表示 (無制限は ∞)。 */
export function formatRetryLimit(text: string | undefined | null): string {
	const n = rateLimitMaxRetriesFor(text)
	return Number.isFinite(n) ? String(n) : "∞"
}

// Incline (#121): 1 日あたりの枠 (RPD) が尽きたことを示す文面。Gemini は quotaId に
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier" のように PerDay を含める。
// 日次の枠は待っても (数分〜数時間では) 戻らないので、自動リトライせず人に知らせる。
const DAILY_QUOTA_PATTERN = /per.?day|requests per day|daily (quota|limit)/i
const QUOTA_CONTEXT_PATTERN = /quota|resource.?exhausted|rate.?limit|\b429\b/i

export function isDailyQuotaErrorText(text: string | undefined | null): boolean {
	return typeof text === "string" && QUOTA_CONTEXT_PATTERN.test(text) && DAILY_QUOTA_PATTERN.test(text)
}

/** "Please retry in 27.951873488s" → 27952 (ms)。見つからなければ undefined。 */
export function parseRetryAfterMs(text: string | undefined | null): number | undefined {
	if (typeof text !== "string") {
		return undefined
	}
	const match = text.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)\s*s/i)
	if (!match) {
		return undefined
	}
	const seconds = Number.parseFloat(match[1])
	return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined
}

/**
 * 自動リトライ前の待機時間 (ms)。既定 60 秒から、連続失敗ごとに倍々 (上限 20 分)。
 * サーバーの "retry in Ns" ヒントの方が長ければそちらを尊重する。テスト環境では 0。
 */
export function rateLimitRetryDelayMs(text: string | undefined | null, attempt = 1): number {
	if (IS_TEST_ENV) {
		return 0
	}
	// 連続失敗するほど倍々で長く待つ (固定間隔で叩き続けると、プロバイダ側で長期ペナルティになる)。
	const server = isServerErrorText(text)
	const cap = server ? SERVER_ERROR_MAX_DELAY_MS : RATE_LIMIT_RETRY_MAX_DELAY_MS
	const backoff = Math.min(retryDelayMs * 2 ** Math.max(0, Math.min(attempt, 30) - 1), Math.max(retryDelayMs, cap))
	const waitMs = Math.max(backoff, parseRetryAfterMs(text) ?? 0)
	// 429 を受けたら、次のモデルリクエストも同じ時間は送らない (別経路の再試行が割り込んで叩き続けないように)。503 / 504 は枠とは無関係。
	if (!server) {
		dynamicModelRateLimiter.coolDown(waitMs)
	}
	return waitMs
}

// --- サーキットブレーカー (暴走止め) -------------------------------------
// 成功が一度も無いまま連続でレート制限 / クォータ超過になったら、自動リトライとウォッチドッグを止めて人に知らせる。
// 無限に叩き続けると、枠が戻らないどころかプロバイダ側で長期ペナルティになる (一晩で 1,000 件超の 429 を送った実績)。
export const RATE_LIMIT_BREAKER_THRESHOLD = 5
/** 止めている時間 (ms)。この間は自動リトライもウォッチドッグの催促も出さない。人が手動で送るのは妨げない。 */
export const RATE_LIMIT_BREAKER_OPEN_MS = 60 * 60_000
let consecutiveRateLimitFailures = 0
let breakerOpenUntil = 0

/** 連続失敗を 1 つ数える。しきい値に達してブレーカーが開いたら true (その瞬間だけ)。 */
export function recordRateLimitFailure(now: number = Date.now()): boolean {
	consecutiveRateLimitFailures++
	if (consecutiveRateLimitFailures >= RATE_LIMIT_BREAKER_THRESHOLD && breakerOpenUntil <= now) {
		breakerOpenUntil = now + RATE_LIMIT_BREAKER_OPEN_MS
		logActivity("BREAKER", `OPEN after ${consecutiveRateLimitFailures} consecutive rate-limit failures; auto-retry/watchdog/HTTP stopped until ${stamp1(breakerOpenUntil)}`)
		return true
	}
	return false
}

/** リクエストが通った (トークン実績が届いた)。連続失敗を 0 に戻し、ブレーカーを閉じる。 */
export function recordRateLimitSuccess(): void {
	rateLimitGaveUp = false
	if (breakerOpenUntil > 0 || consecutiveRateLimitFailures > 0) {
		logActivity("BREAKER", `reset (success after ${consecutiveRateLimitFailures} failure(s))`)
	}
	consecutiveRateLimitFailures = 0
	breakerOpenUntil = 0
}

// 自動リトライを諦めた (最大回数に達した / 日次の枠切れ / ブレーカー) 状態。成功実績が届くまで続き、その間ウォッチドッグは
// 催促しない (催促は新しいターン = 新しいリクエストなので、枠切れのキーを叩き直すことになる)。
let rateLimitGaveUp = false

export function markRateLimitGaveUp(reason: string): void {
	if (!rateLimitGaveUp) {
		logActivity("RETRY", `GAVE UP: ${reason}; watchdog nudges suspended until a request succeeds`)
	}
	rateLimitGaveUp = true
}

/** ウォッチドッグが催促してはいけない状態か (リトライを諦めた、またはブレーカーが開いている)。 */
export function isRateLimitHalted(now: number = Date.now()): boolean {
	return rateLimitGaveUp || breakerOpenUntil > now
}

/** ブレーカーを開いたときの API キーの指紋 (キーそのものは持たない)。キーが変わったら解除するために使う。 */
let breakerKeyFingerprint: string | undefined

export function resetRateLimitBreaker(why: string): void {
	if (breakerOpenUntil > 0 || consecutiveRateLimitFailures > 0 || rateLimitGaveUp) {
		logActivity("BREAKER", `reset (${why})`)
	}
	breakerOpenUntil = 0
	consecutiveRateLimitFailures = 0
	rateLimitGaveUp = false
	breakerKeyFingerprint = undefined
}

export function breakerOpenUntilMs(): number {
	return breakerOpenUntil
}

export function isRateLimitBreakerOpen(now: number = Date.now()): boolean {
	return breakerOpenUntil > now
}

// --- HTTP 単位のゲート (最も細かい粒度) -----------------------------------
// beforeModel / beforeTool のフックは『モデルリクエスト 1 回』『ツール 1 回』の粒度で、その下の再試行
// (SDK 内部のリトライ最大 6 回、エージェントのプロバイダエラー再試行) は素通しだった。実際の HTTP 発行地点
// (fetch) にウェイトを入れ、再試行も含めた全リクエストに (a) 最低間隔 (b) 429 後の倍々の冷却
// (c) ブレーカーが開いている間の即時拒否 を効かせる。対象は枠の厳しい Gemini (generativelanguage) のみ。
const GATED_HOST_PATTERN = /(^|\.)generativelanguage\.googleapis\.com$/i
const HTTP_COOLDOWN_BASE_MS = 30_000
let lastHttpAt = 0
let httpChain: Promise<void> = Promise.resolve()
let httpConsecutive429 = 0

/** リクエストの API キー (ヘッダ x-goog-api-key か ?key=) の短い指紋。キー本体はログにも変数にも残さない。 */
function keyFingerprint(input: unknown, init?: RequestInit): string | undefined {
	let key: string | undefined
	try {
		const h = init?.headers
		if (h instanceof Headers) {
			key = h.get("x-goog-api-key") ?? undefined
		} else if (Array.isArray(h)) {
			key = h.find(([k]) => k.toLowerCase() === "x-goog-api-key")?.[1]
		} else if (h) {
			const rec = h as Record<string, string>
			key = rec["x-goog-api-key"] ?? rec["X-Goog-Api-Key"]
		}
		if (!key) {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url
			key = new URL(String(url)).searchParams.get("key") ?? undefined
		}
	} catch {}
	return key ? `${key.length}:${key.slice(-4)}` : undefined
}

function urlLabel(input: unknown): string {
	try {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url
		const u = new URL(String(url))
		return `${u.hostname}${u.pathname}`
	} catch {
		return "?"
	}
}

function gatedHost(input: unknown): boolean {
	try {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url
		return typeof url === "string" && GATED_HOST_PATTERN.test(new URL(url).hostname)
	} catch {
		return false
	}
}

/** Gemini への HTTP リクエストを 1 件ずつ、最低間隔を空けて通す。順番待ちは直列。 */
async function waitHttpTurn(signal: AbortSignal | null | undefined): Promise<void> {
	const turn = httpChain.then(async () => {
		const spacing = dynamicModelRateLimiter.getMinSpacingMs()
		const wait = Math.max(0, lastHttpAt + spacing - Date.now())
		if (wait > 0 && !IS_TEST_ENV) {
			Logger.log(`[INCLINE] [${inclineTimestamp()}] RateLimiter http [gemini]: WAIT ${wait}ms (spacing)`)
			logActivity("WAIT", `${wait}ms before HTTP request (min-spacing ${spacing}ms)`)
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, wait)
				signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
			})
		}
		lastHttpAt = Date.now()
	})
	httpChain = turn.catch(() => undefined)
	await turn
}

/** SDK の内部再試行 (最大 6 回) に任せず、上に失敗として返すステータス。再試行は INCLINE のホスト側に一本化する。 */
const FAIL_FAST_STATUSES = new Set([429, 502, 503, 504])

async function failFastError(response: Response): Promise<Error> {
	const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 1200)
	// 人が読むメッセージを先頭に (画面の主文)、元の本文は後ろに付ける ("Original error" で見られる)。
	let friendly = ""
	try {
		friendly = String(JSON.parse(body)?.error?.message ?? "")
	} catch {}
	const fallback = response.status === 429 ? "Too Many Requests" : `HTTP ${response.status}`
	return new Error(`${response.status} ${friendly || fallback}${body ? ` -- Original response: ${body}` : ""}`)
}

/**
 * fetch にゲートを被せて返す。拡張は SDK に独自の fetch (プロキシ / CA 対応、providerConfig.fetch) を渡しており
 * globalThis.fetch を差し替えても素通りになるので、その fetch (resolveProviderFetch) をここで包む。
 */
export function createRateLimitedFetch(original: typeof fetch): typeof fetch {
	if (!original || (original as { __inclineGated?: boolean }).__inclineGated) {
		return original
	}
	const gated = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		if (!gatedHost(input)) {
			const res = await original(input, init)
			if (FAIL_FAST_STATUSES.has(res.status)) {
				logActivity("API", `HTTP ${res.status} ${urlLabel(input)} (fail fast: no SDK internal retry)`)
				throw await failFastError(res)
			}
			return res
		}
		const fingerprint = keyFingerprint(input, init)
		if (isRateLimitBreakerOpen() && breakerKeyFingerprint && fingerprint && fingerprint !== breakerKeyFingerprint) {
			resetRateLimitBreaker("API key changed")
		}
		if (isRateLimitBreakerOpen()) {
			// 開いている間は送らない。SDK の再試行も、ここで即座に失敗して終わる。
			logActivity("API", `HTTP BLOCKED locally (breaker open): ${urlLabel(input)}`)
			const until = new Date(breakerOpenUntilMs()).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
			throw new Error(
				`429 exceeded your current quota. [INCLINE] Not sent: this API key got 429 five times in a row, so requests are paused locally until ${until} to avoid a longer penalty. Changing the API key lifts the pause immediately; otherwise it lifts automatically at ${until}.`,
			)
		}
		const cooldown = dynamicModelRateLimiter.cooldownRemainingMs()
		if (cooldown > 0 && !IS_TEST_ENV) {
			logActivity("WAIT", `${cooldown}ms cooldown after 429 before HTTP request`)
			await sleep(cooldown)
		}
		await waitHttpTurn(init?.signal)
		const startedAt = Date.now()
		const response = await original(input, init)
		logActivity("API", `HTTP ${response.status} ${urlLabel(input)} (${Date.now() - startedAt}ms to response)`)
		if (response.status === 429) {
			httpConsecutive429++
			const headerMs = Number.parseFloat(response.headers.get("retry-after") ?? "") * 1000
			const backoff = Math.min(HTTP_COOLDOWN_BASE_MS * 2 ** (httpConsecutive429 - 1), RATE_LIMIT_RETRY_MAX_DELAY_MS)
			dynamicModelRateLimiter.coolDown(Math.max(backoff, Number.isFinite(headerMs) ? headerMs : 0))
			if (recordRateLimitFailure()) {
				breakerKeyFingerprint = fingerprint
				Logger.error("[INCLINE] Rate-limit circuit breaker opened at the HTTP gate (consecutive 429s)")
			}
			// SDK 内部の再試行に任せず、ここで失敗として上に返す。任せると、冷却の待ちが積み重なって失敗が確定するまで画面に何も出ない
			// (約 14 分)。上で Incline の自動リトライ (カウントダウン表示 / 中断 / 上限 / ウォッチドッグ抑止) に一本化する。
			// 本文 (エラー文 + "retry in Ns" のヒント) を含めるので、isRateLimitErrorText / parseRetryAfterMs がそのまま効く。
			throw await failFastError(response)
		} else if (FAIL_FAST_STATUSES.has(response.status)) {
			// 502 / 503 / 504 はサーバー側の失敗。枠 (429) とは別なので、ブレーカーには数えず、冷却もかけない。
			throw await failFastError(response)
		} else if (response.ok) {
			httpConsecutive429 = 0
			recordRateLimitSuccess()
		}
		return response
	}) as typeof fetch & { __inclineGated?: boolean }
	gated.__inclineGated = true
	;(gated as unknown as { preconnect?: unknown }).preconnect = (original as unknown as { preconnect?: unknown }).preconnect
	return gated
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 直前の自動リトライ (再開ターン) が実際に処理を進めたか。
 * モデルが1トークンでも出力した / ツールを1回でも実行したなら「進捗あり」とみなす。
 * 進捗があった後にまたレート制限に当たった場合は連続失敗カウントをリセットし、
 * 「少し進んでまた429」を繰り返しても打ち切られないようにする。
 */
export function retryRunMadeProgress(result: { usage?: { outputTokens?: number }; toolCalls?: unknown[] } | undefined): boolean {
	if (!result) {
		return false
	}
	return (result.usage?.outputTokens ?? 0) > 0 || (result.toolCalls?.length ?? 0) > 0
}
