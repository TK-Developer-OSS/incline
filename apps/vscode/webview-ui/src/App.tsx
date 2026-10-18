import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useState } from "react"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import ProjectBadge from "./components/chat/ProjectBadge"
import HistoryView from "./components/history/HistoryView"
import MarketplaceView from "./components/marketplace/MarketplaceView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import { openClinePassSubscriptionIfPending } from "./components/onboarding/clinePassSubscribe"
import OnboardingView from "./components/onboarding/OnboardingView"
import SettingsView from "./components/settings/SettingsView"
import TermsGate, { TERMS_BANNER_ID } from "./components/welcome/TermsGate"
import WorktreesView from "./components/worktrees/WorktreesView"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

const AppContent = () => {
	const [termsAccepted, setTermsAccepted] = useState(false)
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		showMarketplace,
		showMcp,
		mcpTab,
		showSettings,
		settingsNavigationRequest,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		dismissedBanners,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		closeMarketplaceView,
		hideAnnouncement,
		workspaceRoots,
		mcpActive,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization, accountSwitch, accountSwitchError } = useClineAuth()

	const showUpdateAnnouncementModal = useCallback(() => {
		setShowAnnouncement(true)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [setShouldShowAnnouncement, setShowAnnouncement])

	useEffect(() => {
		if (!didHydrateState || showWelcome || !shouldShowAnnouncement || showAnnouncement) {
			return
		}
		showUpdateAnnouncementModal()
	}, [didHydrateState, showWelcome, shouldShowAnnouncement, showAnnouncement, showUpdateAnnouncementModal])

	// Open the ClinePass subscription page once auth completes. Lives here (not in OnboardingView)
	// because handleAuthCallback unmounts onboarding before the clineUser update arrives.
	useEffect(() => {
		if (clineUser?.uid) {
			openClinePassSubscriptionIfPending(clineUser.appBaseUrl)
		}
	}, [clineUser?.uid, clineUser?.appBaseUrl])

	if (!didHydrateState) {
		return null
	}

	// 利用規約に同意するまで、他の画面は一切表示しない。
	if (!termsAccepted && !dismissedBanners?.some((b) => b.bannerId === TERMS_BANNER_ID)) {
		return <TermsGate onAccepted={() => setTermsAccepted(true)} />
	}

	if (showWelcome) {
		return <OnboardingView />
	}

	return (
		<div
			className="flex h-screen w-full flex-col"
			// MCP の操作を受けている間は、アプリ枠を青にする (#71)
			style={mcpActive ? { boxShadow: "inset 0 0 0 3px #3b82f6" } : undefined}>
			<ProjectBadge workspaceRoots={workspaceRoots} />
			{showSettings && <SettingsView navigationRequest={settingsNavigationRequest} onDone={hideSettings} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showMarketplace && <MarketplaceView initialType={mcpTab ? "mcp" : undefined} onDone={closeMarketplaceView} />}
			{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
			{showAccount && (
				<AccountView
					activeOrganization={activeOrganization}
					clineUser={clineUser}
					onDone={hideAccount}
					organizations={organizations}
				/>
			)}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={showSettings || showHistory || showMarketplace || showMcp || showAccount || showWorktrees}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
