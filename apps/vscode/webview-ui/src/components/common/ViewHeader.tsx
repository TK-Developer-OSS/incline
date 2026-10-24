import { Button } from "@/components/ui/button"
import { getEnvironmentColor } from "@/utils/environmentColors"
import type { Environment } from "../../../../src/shared/config-types"

const ENV_DISPLAY_NAMES: Record<Environment, string> = {
	production: "Production",
	staging: "Staging",
	local: "Local",
	selfHosted: "Self-hosted",
}

type ViewHeaderProps = {
	title: string
	onDone: () => void
	/**
	 * Settings view: show "Cancel" next to "Save". Both close the view the same way today, because settings are saved
	 * as you change them (a real draft / revert model is tracked as #128).
	 */
	showClose?: boolean
	showEnvironmentSuffix?: boolean
	environment?: Environment
}

const ViewHeader = ({ title, onDone, showClose, showEnvironmentSuffix, environment }: ViewHeaderProps) => {
	const showSubtext = showEnvironmentSuffix && environment && environment !== "production"
	const capitalizedEnv = environment ? ENV_DISPLAY_NAMES[environment] : ""
	const titleColor = getEnvironmentColor(environment)

	return (
		<div className="flex justify-between items-center py-2.5 px-5 mb-[17px]">
			<div className="relative">
				<h3 className="m-0 text-lg font-normal" style={{ color: titleColor }}>
					{title}
				</h3>
				{showSubtext && (
					<span className="absolute left-0 top-8 -translate-y-1 text-xs text-description whitespace-nowrap">
						{capitalizedEnv} environment
					</span>
				)}
			</div>
			<div className="flex gap-2">
				{showClose && (
					<Button
						data-testid="view-close"
						size="header"
						variant="secondary"
						onClick={onDone}
						title="Cancel: closes this view. Changes you already made were saved as you typed and are not reverted.">
						Cancel
					</Button>
				)}
				<Button size="header" onClick={onDone} title={showClose ? "Save: closes this view (changes are saved as you type)" : undefined}>
					{showClose ? "Save" : "Done"}
				</Button>
			</div>
		</div>
	)
}

export default ViewHeader
