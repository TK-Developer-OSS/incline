import { ImgHTMLAttributes } from "react"
import logo from "./incline-logo.png"

/** INCLINE のロゴ (本家 Cline のロゴを差し替え)。 */
const ClineLogoWhite = ({
	environment: _environment,
	...props
}: ImgHTMLAttributes<HTMLImageElement> & { environment?: unknown }) => (
	<img alt="INCLINE" height={50} src={logo} width={50} {...props} />
)

export default ClineLogoWhite
