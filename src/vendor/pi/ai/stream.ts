// VENDOR NOTE (github-router): the upstream version of this file has
// `import "./providers/register-builtins.ts";` at the top, which eagerly loads
// every provider implementation (and their npm SDKs: @anthropic-ai/sdk,
// @google/genai, openai, @aws-sdk/client-bedrock-runtime, @mistralai/mistralai).
// We vendor pi-agent-core to drive Copilot via a custom `streamFn`, so the
// provider registry is never consulted at runtime; we strip the side-effect
// import to avoid pulling unused SDKs into the proxy bundle.
//
// If you ever need to register a custom provider against the registry,
// call `registerApiProvider` from `./api-registry.ts` yourself.

import { getApiProvider } from "./api-registry.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
