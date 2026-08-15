import {
  assertNarrationProviderName,
  createNarrationRequest,
  type NarrationProviderCloseContext,
  type NarrationProviderName,
  type NarrationProviderPlugin,
  type NarrationProviderPrepareContext,
  type NarrationRequest,
} from "./contracts.js";

export type NarrationProviderRegistry = {
  register(plugin: NarrationProviderPlugin): NarrationProviderRegistry;
  resolve(name: NarrationProviderName): NarrationProviderPlugin;
  has(name: NarrationProviderName): boolean;
  names(): readonly NarrationProviderName[];
  close(primaryError?: unknown): Promise<void>;
};

type ProviderCloseFailure = {
  provider: string;
  error: unknown;
};

export function createNarrationProviderRegistry(
  plugins: readonly NarrationProviderPlugin[] = [],
): NarrationProviderRegistry {
  const providers = new Map<string, NarrationProviderPlugin>();
  let closeResult: Promise<readonly ProviderCloseFailure[]> | undefined;

  const registry: NarrationProviderRegistry = {
    register(plugin) {
      if (closeResult !== undefined) {
        throw new Error("Narration provider registry is closed and cannot accept registrations.");
      }

      assertNarrationProviderName(plugin.name);

      if (providers.has(plugin.name)) {
        throw new Error(`Narration provider ${JSON.stringify(plugin.name)} is already registered.`);
      }

      providers.set(plugin.name, plugin);
      return registry;
    },
    resolve(name) {
      assertNarrationProviderName(name);

      const plugin = providers.get(name);

      if (plugin !== undefined) {
        return plugin;
      }

      const registered = [...providers.keys()].sort().map((provider) => JSON.stringify(provider));
      const suffix = registered.length === 0
        ? "No narration providers are registered."
        : `Registered providers: ${registered.join(", ")}.`;

      throw new Error(`Narration provider ${JSON.stringify(name)} is not registered. ${suffix}`);
    },
    has(name) {
      assertNarrationProviderName(name);
      return providers.has(name);
    },
    names() {
      return [...providers.keys()];
    },
    async close(primaryError) {
      closeResult ??= closeProviders(providers.values(), { error: primaryError });
      const failures = await closeResult;

      if (primaryError === undefined && failures.length === 0) {
        return;
      }

      if (primaryError !== undefined && failures.length === 0) {
        throw primaryError;
      }

      const errors = [
        ...(primaryError === undefined ? [] : [primaryError]),
        ...failures.map((failure) => failure.error),
      ];
      const failedProviders = failures.map((failure) => JSON.stringify(failure.provider)).join(", ");
      const message = primaryError === undefined
        ? `Failed to close narration provider${failures.length === 1 ? "" : "s"}: ${failedProviders}.`
        : `Narration operation failed and provider cleanup also failed for: ${failedProviders}.`;

      throw new AggregateError(errors, message, primaryError === undefined ? undefined : { cause: primaryError });
    },
  };

  for (const plugin of plugins) {
    registry.register(plugin);
  }

  return registry;
}

export async function prepareNarrationProviderRequest(
  plugin: NarrationProviderPlugin,
  request: NarrationRequest,
  context: NarrationProviderPrepareContext,
): Promise<NarrationRequest> {
  assertNarrationProviderName(plugin.name);

  if (request.provider !== plugin.name) {
    throw new Error(
      `Narration provider plugin ${JSON.stringify(plugin.name)} cannot prepare request for ${JSON.stringify(request.provider)}.`,
    );
  }

  context.signal.throwIfAborted();
  const prepared = createNarrationRequest(await plugin.prepareRequest(request, context));
  context.signal.throwIfAborted();

  if (prepared.provider !== plugin.name) {
    throw new Error(
      `Narration provider plugin ${JSON.stringify(plugin.name)} changed provider identity to ${JSON.stringify(prepared.provider)} during preparation.`,
    );
  }

  validateNarrationProviderCapabilities(plugin, prepared);
  return prepared;
}

export function validateNarrationProviderCapabilities(
  plugin: Pick<NarrationProviderPlugin, "name" | "capabilities">,
  request: NarrationRequest,
): void {
  const { capabilities } = plugin;

  if (
    capabilities.languages !== "provider-defined"
    && request.language !== undefined
    && !capabilities.languages.includes(request.language)
  ) {
    throw unsupportedCapability(plugin.name, "language", request.language, capabilities.languages);
  }

  if (
    capabilities.outputFormats !== "provider-defined"
    && !capabilities.outputFormats.includes(request.format)
  ) {
    throw unsupportedCapability(plugin.name, "output format", request.format, capabilities.outputFormats);
  }

  if (
    capabilities.sampleRates !== "provider-defined"
    && !capabilities.sampleRates.includes(request.sampleRate)
  ) {
    throw unsupportedCapability(plugin.name, "sample rate", request.sampleRate, capabilities.sampleRates);
  }

  if (capabilities.instructions === "unsupported" && request.instructions.trim().length > 0) {
    throw new Error(
      `Narration provider ${JSON.stringify(plugin.name)} does not support instructions.`,
    );
  }
}

async function closeProviders(
  plugins: Iterable<NarrationProviderPlugin>,
  context: NarrationProviderCloseContext,
): Promise<readonly ProviderCloseFailure[]> {
  const failures: ProviderCloseFailure[] = [];

  for (const plugin of plugins) {
    try {
      await plugin.close?.(context);
    } catch (error) {
      failures.push({ provider: plugin.name, error });
    }
  }

  return failures;
}

function unsupportedCapability(
  provider: string,
  dimension: string,
  value: string | number,
  supported: readonly (string | number)[],
): Error {
  return new Error(
    `Narration provider ${JSON.stringify(provider)} does not support ${dimension} ${JSON.stringify(value)}. Supported values: ${supported.map((item) => JSON.stringify(item)).join(", ")}.`,
  );
}
