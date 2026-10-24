import type { ClineMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import { ClineAuthStatus } from "@/components/account/ClineAuthStatus"
import ClineFreeModelLimitError from "@/components/chat/ClineFreeModelLimitError"
import ClineFreePromotionEndedError from "@/components/chat/ClineFreePromotionEndedError"
import ClinePassLimitError from "@/components/chat/ClinePassLimitError"
import CreditLimitError from "@/components/chat/CreditLimitError"
import EntitlementError from "@/components/chat/EntitlementError"
import OrgClinePassRestrictionError from "@/components/chat/OrgClinePassRestrictionError"
import SpendLimitError from "@/components/chat/SpendLimitError"
import { Button } from "@/components/ui/button"
import { useClineAuth, useClineSignIn } from "@/context/ClineAuthContext"
import { describeProviderError } from "@shared/provider-error"
import { ClineError, ClineErrorType, MODEL_NOT_FOUND_GUIDANCE } from "../../../../src/services/error/ClineError"

const _errorColor = "var(--vscode-errorForeground)"

/**
 * Incline: エラーを枠で囲み、元のエラー本文 (プロバイダが返した JSON など) は折りたたみで見られるようにする。
 * 本文に "[INCLINE]" の注記 (ローカルで止めたときの説明) があれば、その注記を枠の中の主文にする。
 */
const splitInclineNotice = (text: string): { summary: string; raw: string } => {
	const i = text.indexOf("[INCLINE]")
	const body = i >= 0 ? text.slice(i + "[INCLINE]".length).trim() : text
	// "... -- Original response: {json}" の後ろは主文に出さない (Original error の折りたたみに全文がある)。
	const cut = body.indexOf(" -- Original response:")
	return { summary: cut >= 0 ? body.slice(0, cut).trim() : body, raw: text }
}

/**
 * 元のエラー本文から人が読むメッセージを取り出す。{"error":{"message":...}} のようにトップレベルに message が無い JSON だと、
 * ClineError は String(object) = "[object Object]" を作ってしまうので、その場合はこちらで探す。
 */
const extractProviderMessage = (raw: string): string | undefined => {
	const body = raw.slice(Math.max(0, raw.indexOf("{")))
	try {
		const parsed = JSON.parse(body)
		const m = parsed?.error?.message ?? parsed?.message
		if (typeof m === "string" && m.trim()) {
			return m
		}
	} catch {}
	return raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
}

const ErrorFrame = ({ children, raw }: { children: React.ReactNode; raw?: string }) => {
	// 見出し: HTTP ステータスと種類 (429 枠切れ / 503 過負荷など)。本文だけだと、何のエラーか分からないので。
	const info = describeProviderError(raw)
	return (
	<div
		className="flex flex-col gap-2 rounded p-2"
		data-testid="error-frame"
		style={{
			border: "1px solid color-mix(in srgb, var(--vscode-errorForeground) 50%, transparent)",
			background: "color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent)",
		}}>
		{info && (
			<div className="text-xs font-semibold text-error" data-testid="error-badge">
				{info.label}
			</div>
		)}
		<div className="m-0 whitespace-pre-wrap text-error wrap-anywhere">{children}</div>
		{raw && (
			<details className="text-xs">
				<summary className="cursor-pointer opacity-80">Original error</summary>
				<pre className="m-0 mt-1 whitespace-pre-wrap wrap-anywhere opacity-80">{raw}</pre>
			</details>
		)}
	</div>
	)
}

interface ErrorRowProps {
	message: ClineMessage
	errorType: "error" | "mistake_limit_reached" | "diff_error" | "clineignore_error"
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
	retryFailedRequest?: () => Promise<boolean>
}

const ErrorRow = memo((props: ErrorRowProps) => {
	const { message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage, retryFailedRequest } = props
	const { clineUser } = useClineAuth()
	const rawApiError = apiRequestFailedMessage || apiReqStreamingFailedMessage

	const { isLoginLoading, authStatusMessage, handleSignIn } = useClineSignIn()

	const renderErrorContent = () => {
		switch (errorType) {
			case "error":
			case "mistake_limit_reached":
				// Handle API request errors with special error parsing
				if (rawApiError) {
					// FIXME: ClineError parsing should not be applied to non-Cline providers, but it seems we're using clineErrorMessage below in the default error display
					const clineError = ClineError.parse(rawApiError)
					const parsedMessage = clineError?._error?.message || clineError?.message
					const errorMessage =
						typeof parsedMessage === "string" && parsedMessage !== "[object Object]"
							? parsedMessage
							: (extractProviderMessage(rawApiError) ?? rawApiError)
					const requestId = clineError?._error?.request_id
					const providerId = clineError?.providerId || clineError?._error?.providerId
					// Deliberately narrower than the shared isClineManagedProvider (which
					// also matches cline-pass): only usage-billing errors get the credit
					// and login prompts below.
					const isClineUsageBillingProvider = providerId === "cline"
					const errorCode = clineError?._error?.code

					if (clineError?.isErrorType(ClineErrorType.Balance)) {
						const errorDetails = clineError._error?.details
						if (isClineUsageBillingProvider || errorDetails?.buy_credits_url) {
							return (
								<CreditLimitError
									buyCreditsUrl={errorDetails?.buy_credits_url}
									currentBalance={errorDetails?.current_balance}
									message={errorDetails?.message}
									retryFailedRequest={retryFailedRequest}
									totalPromotions={errorDetails?.total_promotions}
									totalSpent={errorDetails?.total_spent}
								/>
							)
						}
					}

					if (clineError?.isErrorType(ClineErrorType.SpendLimit)) {
						const d = clineError._error?.details
						return (
							<SpendLimitError
								budgetPeriod={d?.budget_period}
								limitUsd={d?.limit_usd}
								message={d?.message || errorMessage}
								resetsAt={d?.resets_at}
								spentUsd={d?.spent_usd}
							/>
						)
					}

					if (clineError?.isErrorType(ClineErrorType.Entitlement)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <EntitlementError message={detailMessage} retryFailedRequest={retryFailedRequest} />
					}

					if (clineError?.isErrorType(ClineErrorType.OrgClinePassRestriction)) {
						return <OrgClinePassRestrictionError />
					}

					if (clineError?.isErrorType(ClineErrorType.ClinePassLimit)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <ClinePassLimitError message={detailMessage} />
					}

					if (clineError?.isErrorType(ClineErrorType.ClineFreeModelLimit)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <ClineFreeModelLimitError message={detailMessage} />
					}

					// A retired free model answers model-not-found once its promotion
					// ends — dedicated copy plus a route into the model picker,
					// since retrying the deleted model can never succeed.
					if (clineError?.isErrorType(ClineErrorType.ClineFreePromotionEnded)) {
						return <ClineFreePromotionEndedError />
					}

					if (clineError?.isErrorType(ClineErrorType.RateLimit)) {
						return (
							<ErrorFrame raw={rawApiError}>
								{splitInclineNotice(errorMessage).summary}
								{requestId && <div>Request ID: {requestId}</div>}
							</ErrorFrame>
						)
					}

					if (clineError?.isErrorType(ClineErrorType.QuotaExceeded)) {
						const detailMessage = clineError?._error?.details?.message || errorMessage
						return <ErrorFrame raw={rawApiError}>{splitInclineNotice(detailMessage).summary}</ErrorFrame>
					}

					// A 404/405/410 is the server saying the model id or endpoint
					// path does not exist. The host already appends this guidance
					// when it can recognise the message text; add it here only
					// when the status alone carried the verdict.
					const notFoundGuidance =
						clineError?.isErrorType(ClineErrorType.NotFound) && !errorMessage.includes(MODEL_NOT_FOUND_GUIDANCE)
							? `The model or endpoint was not found. ${MODEL_NOT_FOUND_GUIDANCE}`
							: undefined

					if (clineError?.isErrorType(ClineErrorType.Auth) && isClineUsageBillingProvider) {
						return !clineUser ? (
							// User is using Cline provider and is not logged in
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-center rounded border border-neutral-500/30 bg-vscode-editor-background p-6 text-center text-vscode-foreground">
									Whoops looks like you're logged out – click below to sign in
								</div>
								<Button className="w-full" disabled={isLoginLoading} onClick={handleSignIn}>
									Sign in to Cline
									{isLoginLoading && (
										<span className="ml-1 animate-spin">
											<span className="codicon codicon-refresh" />
										</span>
									)}
								</Button>
								<ClineAuthStatus message={authStatusMessage} />
							</div>
						) : (
							// Don't show sign in button after the user has logged in, just ask them to retry
							<div className="mt-4">
								<span className="text-description">(Click "Retry" below)</span>
							</div>
						)
					}

					return (
						<ErrorFrame raw={rawApiError}>
							{/* Display the well-formatted error extracted from the ClineError instance */}

							<header>
								{providerId && <span className="uppercase">[{providerId}] </span>}
								{errorCode && <span>{errorCode}</span>}
								{errorMessage}
								{requestId && <div>Request ID: {requestId}</div>}
							</header>

							{notFoundGuidance && <div>{notFoundGuidance}</div>}

							{/* Windows Powershell Issue */}
							{errorMessage?.toLowerCase()?.includes("powershell") && (
								<div>
									It seems like you're having Windows PowerShell issues, please see this{" "}
									<a
										className="underline text-inherit"
										href="#underconstruction">
										troubleshooting guide
									</a>
									.
								</div>
							)}

						</ErrorFrame>
					)
				}

				// Regular error message
				return (
					<ErrorFrame raw={message.text}>{splitInclineNotice(message.text ?? "").summary}</ErrorFrame>
				)

			case "diff_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>The model used search patterns that don't match anything in the file. Retrying...</div>
					</div>
				)

			case "clineignore_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>
							Cline tried to access <code>{message.text}</code> which is blocked by the <code>.clineignore</code>
							file.
						</div>
					</div>
				)

			default:
				return null
		}
	}

	// For diff_error and clineignore_error, we don't show the header separately
	if (errorType === "diff_error" || errorType === "clineignore_error") {
		return renderErrorContent()
	}

	// For other error types, show header + content
	return renderErrorContent()
})

export default ErrorRow
