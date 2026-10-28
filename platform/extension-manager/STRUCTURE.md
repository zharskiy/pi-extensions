# extension-manager structure

- `index.ts`: the public surface; `createManagedExtension`, `createExtensionManager`, `createBus`, `reportSettingsErrors`.
- `managed-extension.ts`: `createManagedExtension`, `ManagedExtension`; an extension's plugins, settings reload and child exclusions in one call.
- `extension-manager.ts`: `createExtensionManager`; orders plugins by `requires`, enables them, holds the service registry, `disableAll`.
- `bus.ts`: `createBus`; the typed in-process event bus, listener errors to `onError`.
- `settings-errors.ts`: `reportSettingsErrors` (once-per-message warnings).
- `tests/managed-extension.test.ts`: the boot, settings reload order, overrides and child exclusions.
- `tests/extension-manager.test.ts`: plugin order, skips, services and disable order.
- `tests/bus.test.ts`: `createBus`.
- `tests/settings.test.ts`: the settings schema, file merge and warnings.
