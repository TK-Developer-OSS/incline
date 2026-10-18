import { RATE_LIMIT_RPM, RATE_LIMIT_TPM } from "@shared/rate-limits"
import React, { memo, useEffect, useMemo, useState } from "react"
import { formatLargeNumber } from "@/utils/format"

// ゲージの目安上限の既定は SDK 側スロットリングと同じ定数 (@shared/rate-limits)。
// 設定 incline.rateLimit.* で変えた現在値は props (rpmLimit / tpmLimit) で渡される。

const WINDOW_MS = 60_000

/** ホストが送る使用量サンプル (直近60秒)。 */
export interface RateUsageSamples {
	/** サンプルを作ったホストの時刻 (epoch ms)。 */
	at?: number
	reqs?: number[]
	tokens?: { at: number; tokens: number }[]
}

/** サンプルから、ホスト時刻 hostNow での直近60秒の RPM / TPM を計算する。 */
export function computeLiveUsage(usage: RateUsageSamples, hostNow: number): { rpm: number; tpm: number } {
	const cutoff = hostNow - WINDOW_MS
	const rpm = (usage.reqs ?? []).filter((t) => t > cutoff && t <= hostNow).length
	const tpm = (usage.tokens ?? []).filter((s) => s.at > cutoff && s.at <= hostNow).reduce((sum, s) => sum + s.tokens, 0)
	return { rpm, tpm }
}

interface RateMetersProps {
	/**
	 * ホスト集計のサンプル。あれば rpm / tpm よりこちらを優先し、60秒の窓から古い分が抜けていく様子を
	 * 毎秒計算し直して滑らかに表示する (#77)。
	 */
	usage?: RateUsageSamples
	/** 直近60秒のモデルリクエスト数 (概算)。 */
	rpm?: number
	/** 直近60秒の処理トークン数 (概算)。 */
	tpm?: number
	/** 現在の RPM 上限。省略時は既定値。 */
	rpmLimit?: number
	/** 現在の TPM 上限。省略時は既定値。 */
	tpmLimit?: number
	/** 直近24時間のモデルリクエスト数。省略時は RPD 行を出さない。 */
	rpd?: number
	/** 1日あたりの目安上限。未設定なら上限なしで件数のみ表示。 */
	rpdLimit?: number
}

const clampNonNegative = (n: number | undefined): number => {
	const v = typeof n === "number" && Number.isFinite(n) ? n : 0
	return v > 0 ? Math.round(v) : 0
}

function meterColor(ratio: number): string {
	if (ratio >= 1) {
		return "var(--vscode-errorForeground, #f14c4c)"
	}
	if (ratio >= 0.7) {
		return "var(--vscode-editorWarning-foreground, #cca700)"
	}
	return "var(--vscode-charts-green, #89d185)"
}

const Meter: React.FC<{ label: string; value: number; limit: number; display: string; title: string }> = ({
	label,
	value,
	limit,
	display,
	title,
}) => {
	const ratio = limit > 0 ? value / limit : 0
	const pct = Math.min(100, Math.max(0, ratio * 100))
	const color = meterColor(ratio)
	return (
		<div className="flex items-center gap-1.5 text-sm" title={title}>
			<span className="text-description shrink-0 w-9">{label}</span>
			<span className="shrink-0 w-16 text-right tabular-nums" style={{ color }}>
				{display}
			</span>
			<div className="relative h-2 flex-1 overflow-hidden rounded-full bg-code-foreground/20">
				<div
					className="absolute inset-y-0 left-0 rounded-full transition-all"
					style={{ width: `${pct}%`, background: color }}
				/>
			</div>
			<span className="text-description shrink-0 tabular-nums">{limit > 0 ? formatLargeNumber(limit) : "–"}</span>
		</div>
	)
}

/**
 * RPM / TPM のざっくりゲージ。ContextWindow (トークン数) の下に表示する。
 * 値は直近60秒の概算。目安上限は固定値。
 */
const RateMeters: React.FC<RateMetersProps> = ({ rpm, tpm, rpmLimit, tpmLimit, rpd, rpdLimit, usage }) => {
	// サンプルを受け取った時点の「ホスト時刻 - 自分の時刻」。以後は自分の時計 + この差でホスト時刻を推定する。
	const offset = useMemo(() => (usage?.at !== undefined ? usage.at - Date.now() : 0), [usage])
	const hasSamples = usage?.at !== undefined && usage.reqs !== undefined && usage.tokens !== undefined
	const [now, setNow] = useState(() => Date.now())
	const lastSample = Math.max(0, ...(usage?.reqs ?? []), ...((usage?.tokens ?? []).map((s) => s.at)))

	useEffect(() => {
		if (!hasSamples) {
			return
		}
		setNow(Date.now())
		// 窓に残っているサンプルがある間だけ、毎秒計算し直す
		const id = setInterval(() => {
			setNow(Date.now())
		}, 1000)
		return () => clearInterval(id)
	}, [hasSamples, usage])

	const live = hasSamples && usage ? computeLiveUsage(usage, Math.max(now + offset, lastSample)) : undefined
	const rpmValue = clampNonNegative(live ? live.rpm : rpm)
	const tpmValue = clampNonNegative(live ? live.tpm : tpm)
	return (
		<div className="flex flex-col gap-1 mt-1.5">
			<Meter
				display={String(rpmValue)}
				label="RPM"
				limit={rpmLimit && rpmLimit > 0 ? rpmLimit : RATE_LIMIT_RPM}
				title="Model requests in the last 60 seconds (approximate)"
				value={rpmValue}
			/>
			<Meter
				display={formatLargeNumber(tpmValue)}
				label="TPM"
				limit={tpmLimit && tpmLimit > 0 ? tpmLimit : RATE_LIMIT_TPM}
				title="Tokens processed in the last 60 seconds (input + output + cache, approximate)"
				value={tpmValue}
			/>
			{rpd !== undefined && (
				<Meter
					display={String(clampNonNegative(rpd))}
					label="RPD"
					limit={rpdLimit && rpdLimit > 0 ? rpdLimit : 0}
					title="Model requests in the last 24 hours (current session)"
					value={clampNonNegative(rpd)}
				/>
			)}
		</div>
	)
}

export default memo(RateMeters)
