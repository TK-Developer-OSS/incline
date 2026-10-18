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
	/** Show a separate Close button next to Done (closes the view the same way; settings are saved as you change them). */
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
					<Button data-testid="view-close" size="header" variant="secondary" onClick={onDone} title="Close (changes are already saved)">
						Close
					</Button>
				)}
				<Button size="header" onClick={onDone}>
					Done
				</Button>
			</div>
		</div>
	)
}

export default ViewHeader
