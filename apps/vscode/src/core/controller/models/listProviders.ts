import { Empty } from "@/shared/proto/cline/common"
import { ProviderListingsResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, toProviderListingProto } from "./providerCatalogShared"

export async function listProviders(controller: ProviderCatalogController, _request: Empty): Promise<ProviderListingsResponse> {
	// INCLINE: 本家 Cline のバックエンド系プロバイダは一覧に出さない。
	const providers = (await controller.getProviderCatalog().listProviders()).filter(
		(provider) => provider.id !== "cline" && provider.id !== "cline-pass",
	)
	return ProviderListingsResponse.create({
		providers: providers.map(toProviderListingProto),
	})
}
