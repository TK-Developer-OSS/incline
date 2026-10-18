import Section from "../Section"

interface AboutSectionProps {
	version: string
	extensionVariant?: "legacy" | "next"
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const VARIANT_LABELS: Record<"legacy" | "next", string> = {
	legacy: "Legacy",
	next: "Next",
}

const AboutSection = ({ version, extensionVariant, renderSectionHeader }: AboutSectionProps) => {
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<h2 className="text-lg font-semibold">
						INCLINE v{version}
						{extensionVariant && (
							<span className="ml-2 text-sm font-normal text-description">
								({VARIANT_LABELS[extensionVariant]})
							</span>
						)}
					</h2>
					<p>
						An AI assistant that can use your CLI and Editor. INCLINE can handle complex software development tasks
						step-by-step with tools that let it create & edit files, explore large projects, use the browser, and
						execute terminal commands (after you grant permission).
					</p>

					<h3 className="text-md font-semibold">About this fork</h3>
					<p>
						INCLINE is an unofficial fork of Cline (Apache License 2.0, Copyright Cline Bot Inc.). It is not
						affiliated with, endorsed by, or supported by Cline Bot Inc. See the NOTICE file for details.
					</p>
					<p className="text-description">
						Use of this software is at your own risk. The developers have no obligation to provide support.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
