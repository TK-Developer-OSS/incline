import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { memo, useState } from "react"
import ClineLogoWhite from "@/assets/ClineLogoWhite"
import { StateServiceClient } from "@/services/grpc-client"

/** 同意済みかどうかを dismissedBanners に残すときの ID。規約を改定したら版を上げる。 */
export const TERMS_BANNER_ID = "incline-terms-v1"

/**
 * 初回利用時に表示する利用規約。同意するまでアプリの他の画面は一切描画されない
 * (App.tsx で最優先に判定)。同意は dismissedBanners に保存される。
 */
const TermsGate = memo(({ onAccepted }: { onAccepted: () => void }) => {
	const [saving, setSaving] = useState(false)

	const handleAgree = async () => {
		setSaving(true)
		try {
			await StateServiceClient.dismissBanner({ value: TERMS_BANNER_ID })
		} catch (error) {
			console.error("Failed to persist terms acceptance:", error)
		}
		onAccepted()
	}

	return (
		<div className="fixed inset-0 p-0 flex flex-col">
			<div className="h-full px-5 overflow-auto flex flex-col gap-2.5">
				<h2 className="text-lg font-semibold">Hi, I'm INCLINE</h2>
				<div className="flex justify-center my-5">
					<ClineLogoWhite className="size-16" />
				</div>
				<h3 className="font-semibold">Terms of Use</h3>
				<ul className="list-disc pl-5">
					<li>You agree that you use this software at your own risk.</li>
					<li>
						The developers and distributors accept no liability for any damage arising from the use of this software.
					</li>
					<li>The developers have no obligation to provide support for this software.</li>
				</ul>
				<p className="text-(--vscode-descriptionForeground)">
					You must agree to these terms to use INCLINE. If you do not agree, close this panel and do not use the
					software.
				</p>
				<VSCodeButton appearance="primary" className="w-full mt-1" disabled={saving} onClick={handleAgree}>
					I Agree
				</VSCodeButton>
			</div>
		</div>
	)
})

export default TermsGate
