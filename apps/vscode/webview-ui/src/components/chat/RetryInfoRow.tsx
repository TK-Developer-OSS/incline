import { memo, useEffect, useMemo, useState } from "react"
import { MarkdownRow } from "./MarkdownRow"

// 自動リトライ待機の info メッセージ ("… 約 N 秒後に自動リトライします …") を受け取り、
// ホストからの更新 (5秒ごと) の間も 1 秒刻みでカウントダウン表示する。
const RETRY_SECONDS_PATTERN = /約\s*(\d+)\s*秒後/

/** 本文から残り秒数を取り出す。カウントダウン文言でなければ undefined。 */
export function parseRetryRemainingSec(text: string | undefined): number | undefined {
	const m = text?.match(RETRY_SECONDS_PATTERN)
	return m ? Number.parseInt(m[1], 10) : undefined
}

/** 本文中の残り秒数を差し替える。 */
export function withRemainingSec(text: string, sec: number): string {
	return text.replace(RETRY_SECONDS_PATTERN, `約 ${sec} 秒後`)
}

const RetryInfoRow = ({ text }: { text: string }) => {
	const initial = useMemo(() => parseRetryRemainingSec(text), [text])
	// 本文が更新されたら (= ホストから新しい残り秒数が来たら) 基準を取り直す
	const base = useMemo(() => ({ at: Date.now() }), [text])
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (initial === undefined || initial <= 0) {
			return
		}
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [initial, text])

	if (initial === undefined) {
		return <MarkdownRow markdown={text} />
	}
	const elapsed = Math.max(0, Math.floor((now - base.at) / 1000))
	return <MarkdownRow markdown={withRemainingSec(text, Math.max(0, initial - elapsed))} />
}

export default memo(RetryInfoRow)
