import { BannerAction, BannerCardData } from "@shared/cline/banner"
import React from "react"
import { useMount } from "react-use"
import WhatsNewItems from "@/components/common/WhatsNewItems"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useExtensionState } from "@/context/ExtensionStateContext"

interface WhatsNewModalProps {
	open: boolean
	onClose: () => void
	version: string
	welcomeBanners?: BannerCardData[]
	onBannerAction?: (action: BannerAction) => void
}

const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ open, onClose, version, welcomeBanners, onBannerAction }) => {
	const { refreshOpenRouterModels } = useExtensionState()

	// Get latest model list in case user hits shortcut button to set model
	useMount(refreshOpenRouterModels)

	const inlineCodeStyle: React.CSSProperties = {
		backgroundColor: "var(--vscode-textCodeBlock-background)",
		padding: "2px 6px",
		borderRadius: "3px",
		fontFamily: "var(--vscode-editor-font-family)",
		fontSize: "0.9em",
	}

	return (
		<Dialog onOpenChange={(isOpen) => !isOpen && onClose()} open={open}>
			<DialogContent
				aria-describedby="whats-new-description"
				aria-labelledby="whats-new-title"
				className="pt-5 px-5 pb-4 gap-0">
				<div id="whats-new-description">
					<h2
						className="text-lg font-semibold mb-3 pr-6"
						id="whats-new-title"
						style={{ color: "var(--vscode-editor-foreground)" }}>
						🎉 New in v{version}
					</h2>

					<WhatsNewItems
						inlineCodeStyle={inlineCodeStyle}
						onBannerAction={onBannerAction}
						onClose={onClose}
						welcomeBanners={welcomeBanners}
					/>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default WhatsNewModal
