/**
 * Provider registry.
 *
 * Resolves a client-facing model alias to the provider that should handle
 * it, using a model-name → provider lookup table. Falls back to a
 * configured default provider when the alias isn't claimed.
 */
export class ProviderRegistry {
  /**
   * @param {Provider[]} providers
   * @param {string}     defaultProviderName
   */
  constructor(providers, defaultProviderName) {
    this.providers = providers;
    this.defaultProviderName = defaultProviderName;
    this.byName = new Map(providers.map((p) => [p.name, p]));

    if (!this.byName.has(defaultProviderName)) {
      throw new Error(`Default provider "${defaultProviderName}" not found in registry`);
    }
  }

  /** Look up the provider for a given model alias. */
  resolveForModel(model) {
    for (const p of this.providers) {
      if (p.models && p.models.includes(model)) return p;
    }
    return this.byName.get(this.defaultProviderName);
  }

  /** All providers, in registration order. */
  list() {
    return this.providers;
  }
}
